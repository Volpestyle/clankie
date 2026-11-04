# ADR 0348: The Linux socket census reads births as they appear

Status: Proposed, 2026-11-03, from James's approval of the full fix for #440 ("Do the full fix"). Amends the Linux census described in [ADR 0217](0217-fleet-membership-gets-connected-tools.md) and [the fleet-proof README](../../integrations/fleet-proof/README.md).

## Context

The Linux helper proves that exactly one process holds the loopback socket of a fleet request.

- **The census.** It lists `/proc` and reads every thread's FD table of every listed process. Then it lists `/proc` again.
- **The bracket.** `socket_proof` runs this census twice. Between the two runs it pins the owner, checks its ancestry and re-reads the socket.

Until #440, an attempt counted only if both listings named the same PIDs. Any churn discarded the attempt:

- a birth;
- an exit;
- a process that vanished mid-read.

There are 16 attempts and a 600 ms budget. A runner that keeps starting short-lived processes therefore never settled, and admission refused with `fleet_admission_unavailable`. That kept checkpoint's `desktop-codex-hire` red.

#525 (option b) stopped exits from discarding the attempt. Births still did. The Darwin helper has long treated a newborn PID as another candidate to inspect.

## Decision

**A census attempt reads process instances.** An instance is a PID paired with its `/proc/PID` directory inode.

- Each listing comes from `scandir` of the authenticated procfs root, with `d_ino` for every entry. `d_ino` is the same inode `fstat` reports, and part of `kernelIdentity` already.
- A live process keeps its cached dentry, so its pair is stable across listings.
- A reused PID gets a new inode, so it reads as a new instance.

**The attempt repeats.** Each round lists `/proc` and reads only the instances it has not read yet. The census settles on the first listing in which every live instance has been read. At most 1,024 listings fit in one attempt, inside the unchanged 16 attempts and 600 ms deadline.

**What a read counts.** A read is the existing per-process read, unchanged:

- identity is bracketed;
- every thread's private FD table is read, descriptor zero included;
- an unreadable same-user table refuses once it has been denied in three reads of the same instance (it used to refuse on the first);
- foreign-user tables are skipped only on repeated kernel UID and lifetime checks.

**When a process is read again.** That happens in the next listing when:

- its read churned, and the socket was never seen in it. Churn means:
  - a thread list moved;
  - an identity changed under the read, such as an orphan's new parent;
  - it vanished while still live;
  - its same-user table was denied, which happens mid-exit or mid-exec;
- its PID now names a new instance.

**When a process is not read again.** When the socket was never seen in it, and its exit is confirmed. A confirmed exit (#525) is one of:

- its pidfd shows the whole group's exit;
- the kernel has no such PID;
- `pidfd_open` gives `EINVAL`. The PID now names a thread of another process, which `/proc/TID` opens though no listing names it, so the listed process is gone.

Two dying states get a pidfd wait of at most 20 ms inside the deadline: a denied table whose thread has `PF_EXITING`, and an empty `task/` list. Neither state counts as an exit by itself; only the pidfd does.

**When the attempt is discarded.** Exactly as before:

- an instance the socket was seen in churns or exits mid-read;
- an owner is missing from a later listing, or its PID lists a different inode.

Seeing the socket in a second instance is still terminal, at once.

## What the proof guarantees now

For one settled census attempt:

1. Every instance in the settling listing was read during the attempt.
2. Every instance named by any earlier listing of the attempt was either read, or confirmed exited without the socket ever being seen in it. An instance whose read did not complete stays unresolved until one of these is true:
   - it is read;
   - its exit is confirmed by pidfd, `ESRCH` or `EINVAL`;
   - its PID lists a new instance, which is read. A PID is reused only after its old process is reaped.

   An unresolved instance that is merely absent from a later listing still needs that confirmation, or the attempt is discarded.

3. Exactly one instance showed the socket in any read, with a stable identity bracket around that read.
4. That owner is listed in the settling listing as the same instance, with the same PID and the same inode.

The bracket around the census is unchanged:

- the owner is pinned by pidfd, `kernelIdentity` and UID before ancestry;
- the second census must return the identical owner;
- ancestry is rechecked;
- the socket's inode and cookie are re-read;
- the owner is pinned again;
- the procfs namespace boundary is rechecked before any fact is emitted.

This states who held the socket during the observation. It is not a guarantee of present-time ownership. An owner can pass the socket on (`SCM_RIGHTS`, `pidfd_getfd`) after the closing census read the process that receives it, and `socket_proof` still names that owner, which has by then handed it off. That has always been outside the boundary, on Darwin too.

## What it no longer guarantees

- **A stable process set.** The process set is no longer known to be the same at the start and end of an attempt. Processes may be born and exit while the census runs. Each one is read at its own time, not in one window bounded by two identical listings.
- **Incidental re-reads under churn.** A birth used to discard the attempt and so re-read every process. Under churn, that incidentally caught a descriptor passed to an already-read process before the restart. Now an instance is read once per attempt. A transfer into an already-read process (`SCM_RIGHTS`, `pidfd_getfd`) is caught only by the bracketing second census, and only if it happened before that census read the process. That was always the guaranteed boundary: on a quiet machine nothing was re-read either. The README already places queued and later transfers outside the boundary.
- **Immediate refusal on a denied same-user table.** A same-user instance denied once is read again in the next listing. It still refuses after three denials, unless a later read succeeds or its exit is confirmed: it is never skipped while live.
- **Settling under continuous births.** If a birth lands after every listing, the attempt never settles and the request refuses (`attempts_exhausted` or `budget_exhausted`). It never returns the partial read.

## What gets stronger

- **A reused PID is read.** The old equal-listings rule could not see a PID that exited and was reused between its two listings: the listings stayed identical, so the new process was never read. Now the new inode makes it a new instance, and it is read.
- **A replaced owner discards the attempt.** If the owner's PID now names another process, the attempt is discarded instead of returning the old identity.

## Assumptions

- **Inode identity.** A process's `/proc/PID` dentry inode is fixed while the dentry is cached. A reused PID never shares the old inode unless the kernel's inode counter wraps onto it, which is the same assumption `kernelIdentity` already makes.
- **Dentry eviction.** If memory pressure evicts a live process's dentry, its inode changes. That only causes a re-read, or a discarded attempt when it is the owner. It never causes a skip.

## Evidence

Measured in a Linux container (`node:26.7.0-bookworm`, `--privileged --pid=host`, non-root uid 1001).

Real-kernel helper tests, in [the Linux helper tests](../../integrations/fleet-proof/test/linux-proof.py):

- a birth after the first listing is read without discarding the attempt;
- a birth after every listing refuses;
- a birth that inherits the socket mid-census refuses `multiple_owners`;
- a socket passed by `SCM_RIGHTS` to an already-read process is refused `multiple_owners` by the closing census;
- a PID whose old instance the census had read, freed and reused by a socket holder before the next listing, has its new inode read, and refuses `multiple_owners` within the same attempt (root, via `ns_last_pid`);
- a same-user unreadable (`PR_SET_DUMPABLE=0`) process reaped right after its denied read stays unresolved until the kernel confirms its exit;
- an owner that hands its socket to a successor and exits is never admitted under its own fences: the census restarts on the owner change, and the original owner's fences refuse at `owner_pin`. As root, the successor takes the owner's own PID.

The spawn-churn admission measurements are in #440 and the pull request that lands this ADR.

## Consequences

- Fleet admission on Linux converges under ordinary process churn. Sheer process count can still exceed the 600 ms budget: about 3000 idle processes did, on both the old and new helpers.
- `census.attempts` and its refusal reasons keep their meaning: whole-attempt discards only. Per-process re-reads are not reported.
- Darwin is unchanged.

## Revisit when

- A fleet machine's process count nears the about 3000 idle processes that
  exceeded the 600 ms budget on both helpers.
- Linux admission, such as checkpoint's `desktop-codex-hire`, refuses again with
  `attempts_exhausted` or `budget_exhausted` under ordinary churn.
- A kernel change breaks the `/proc/PID` inode identity this record assumes.
