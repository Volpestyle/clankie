# Native local fleet proof

The body admits a local request only when its actual loopback socket belongs to
the current Clankie-linked Herdr pane, or its existing service-owned private-seat
registration. Request headers supply the candidate pane, never a trusted PID.
This helper replaces the `lsof` socket and global `ps` ancestry scans; the
accepted boundary remains [ADR 0217](../../docs/adr/0217-fleet-membership-gets-connected-tools.md).

## Linux host boundary

Linux uses the shipped Python helper, `linux-process-proof.py`, with the same
private transport and body admission checks. It requires a 64-bit Linux kernel
with pidfds (5.3 or newer) and Python 3.9 or newer. Only the **initial PID
namespace** is supported. The helper authenticates procfs with `fstatfs`, checks
the PID namespace through its nsfs descriptor and kernel initial-namespace inode,
and rejects mismatched proc views, `hidepid`, and nested mounts under `/proc`
other than systemd's on-demand `binfmt_misc` mount at `/proc/sys/fs/binfmt_misc`.
Containers refuse with `unsupported_pid_namespace`; a pane label does not
bypass this boundary. Container admission is tracked separately in [VUH-2120](https://linear.app/vuhlp/issue/VUH-2120).

| Guarantee                         | Darwin observation                                | Linux observation                                                                                            |
| --------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Exact connected socket            | libproc reversed TCP endpoint and socket identity | `SOCK_DIAG` reversed loopback endpoint, inode and kernel cookie                                              |
| Unique process owner              | Complete observable descriptor census             | Complete visible PID and every thread's FD table, including descriptor zero and readable foreign-user tables |
| Original process lifetime         | Full BSD birth snapshots                          | Held pidfd, proc-directory inode, boot UUID and start ticks, rechecked before emission                       |
| Same account                      | Kernel effective UID                              | Stable real, effective, saved and filesystem UIDs                                                            |
| Harness ancestry                  | Bracketed kernel parent chain                     | Pinned, bounded parent chain with repeated PID/birth/parent observations                                     |
| Executable and retained arguments | `proc_pidpath` and `KERN_PROCARGS2`               | `/proc/PID/exe` and bounded `/proc/PID/cmdline`, bracketed by lifetime checks                                |
| Private-seat recovery             | Fresh birth and named Codex listener              | Fresh kernel birth and repeated Unix `SOCK_DIAG` listener/cookie/owner proof                                 |

A shared descriptor, unreadable same-user table, missing cookie, changed birth,
ancestry race or exhausted bound refuses the entire observation. An unreadable
foreign-user table is skipped only after repeated kernel UID/lifetime checks
establish it cannot be inspected by this account. Confirmed exits are established
through pidfds; a still-listed zombie does not establish a live holder.
Requests remain fresh and bounded to 600 ms, 16,384 PIDs, 64 ancestors and
4,194,304 descriptors per thread. No `ps`, `lsof`, header PID or bearer fallback
supplies missing authority.

Census-only PID/FD churn (`ENOENT`, `ESRCH` or a changed list) may restart the
whole census, discarding every partial owner and descriptor observation. At most
16 total census attempts share the original 600 ms request deadline. Seeing a
second holder is immediately terminal; permission, lifetime, ancestry, cookie
and namespace failures do not enter this retry. Exhaustion refuses, never returns
the last partial attempt. Successful Linux receipts retain `census.attempts` and
fixed refusal reasons; opt-in native diagnostics retain each retry and the final
attempt count. The body validates this telemetry separately from identity, so
different retry counts cannot make an unchanged process appear replaced.

Linux output adds `kernelIdentity` (`boot-UUID:proc-inode:start-ticks`). Existing
decimal birth fields remain compatible, while body lifetime receipts retain the
complete kernel identity rather than rounding it to microseconds. As on Darwin,
these repeated observations are not an atomic kernel transaction: an unobserved
change and reversal or a descriptor queued in `SCM_RIGHTS` is outside the existing
boundary. No environment or later arguments enter proof output.

The real host-PID-namespace and native Pi TUI evidence is recorded in
[VUH-2118 verification](../../docs/testing/2026-10-11-linux-native-fleet-proof/README.md).

## Darwin observations

The macOS C helper uses the public SDK's `libproc` process and socket structures.
It scans observable processes for the exact reversed TCP endpoint, requires one
distinct owner PID, and records its microsecond birth, socket identity and
bounded, cycle-free parent chain. Duplicate descriptors in one process remain
valid; descriptors held by two processes refuse admission. Lifetimes are checked
around observations. Protected processes outside the effective user are skipped
only when the kernel establishes that identity; unavailable same-user process
observations fail closed. Process, ancestry and elapsed-time bounds also refuse
access rather than returning a partial proof.

Every descriptor table is read whole, because a second holder of the target
socket could be any process. The first read holds 16,384 records; a larger table
is re-read at the size the kernel reports, up to its per-process limit
(`kern.maxfilesperproc`). Only a table beyond that limit refuses
(`fd_list_bounds`). A table past the first read is recorded as `fd_list_large`,
with its PID and count in private request logs only, so one unrelated process
holding tens of thousands of descriptors neither refuses every caller nor hides a
sharer (VUH-2070).

The socket owner requires full `PROC_PIDTBSDINFO` observation and the body's
user identity. Other ancestors use `sysctl(KERN_PROC_PID)` for exact PID, parent
PID, seconds and microseconds of birth across users. This preserves lifetime
checks through Terminal's setuid-root `/usr/bin/login` ancestor without granting
that ancestor ownership or using a weaker owner observation. Unknown, malformed,
changed or unknown ancestry still refuses admission. A confirmed intermediate
exit may trigger one complete re-walk from the same live socket claimant, as
described below.

The helper inspects the bounded union of its all-process, effective-user and
real-user PID lists. A process born between list calls is inspected, including
its sockets; it does not invalidate the entire census. A confirmed exit can be
skipped. An inaccessible live same-user process still refuses the proof.

Unrelated stale descriptors or a changed process lifetime retry only that PID. Each local
retry discards its partial owner and repeats the complete process/FD observation.
Once a target socket was observed, an unstable or exited candidate instead
requires a fresh whole census within the same bounds, so a new socket inheritor
cannot hide outside the earlier PID lists. Only agreeing before/after lifetimes
contribute an owner. Completed observations
of other processes survive this local retry, while the chosen owner, socket and
ancestry retain their final rechecks. There are at most 32 local attempts per
PID, within the unchanged 200 ms scan and 600 ms job caps; a scan whose budget
expires can restart within the existing 32-scan ceiling. Retries wait 1–8 ms,
clipped to the total budget. Hard identity, unavailable/changed ancestry and shared-owner refusals
remain fail-closed. Persistent uncertainty or exceeded bounds refuses access.

The body takes two fresh snapshots around live Herdr and private-seat checks and
requires agreement. Its per-connection identity pin adds a refusal fence against
PID or socket replacement. It never accepts a caller-supplied PID. A missing
helper or unsupported platform refuses admission; there is no legacy socket-scan
fallback. Project identity separately checks the shell and foreground harness
through the process mode below.

### Proof once per connection

Fleet admission is proven once per connection, not once per request
([VUH-2389](https://linear.app/vuhlp/issue/VUH-2389)). The first request on a
loopback connection runs the full proof above. Success binds it to that socket,
with the kernel owner and the lineage from the owner up to the pane's shell
(the whole chain for a private seat), each at its kernel birth, plus the pane
claim, the shell PID and the Herdr binding. A later request on the same live
socket skips the whole-machine census and rechecks only these, all fresh:

- the socket is still connected, with the same endpoints and pane claim;
- the Herdr binding is unchanged, and Herdr still reports the same shell for
  the pane;
- every lineage process is alive at its proven birth (`--birth`, PID-local).
  A parent link changes only when that parent exits, so this also holds the
  owner's ancestry;
- for a private seat, the registry still allows the unbroken part of the chain,
  from the owner up to the first process that no longer matches. Ancestors
  above the registered process, such as a root `login`, need not be observable;
- a server-owned expected-owner pin, if any, is the proven owner.

Any failed or unavailable recheck discards the connection's proof, and that
request runs the full proof, with its usual refusal reasons and metrics. So a
closed socket, an exited or replaced owner, a reparented owner, a moved or
closed pane, a changed binding or an expired private seat refuses or re-proves
exactly as before. A full proof that sees a second holder of the socket still
refuses at once (`multiple_owners`). Fleet metrics count full proofs only;
reused requests are not proof attempts.

The cost is one unseen case. A descriptor the proven owner hands to another
process after its connection was proven is not observed until that connection is
proven again: on a new connection, or after any recheck above fails. Before this
change every request's census refused it while it was shared. The owner is
already a pane member; handing over its connection is the same as proxying for
another process, which ADR 0217 accepts ("anything running in a linked session"),
and a descriptor in flight over `SCM_RIGHTS` was already outside the boundary.
Project proofs, which carry native-session authority, are never reused.

Reuse only helps when connections persist. Node's `fetch`, which every worker
bridge uses, keeps an idle connection only as long as the server's `Keep-Alive`
hint allows, less a margin. At Node's server default of five seconds, even a
3.5 s gap opened a new connection, so each 5 s catalog check arrived on a fresh
one. The local fleet listener therefore keeps idle connections for ten minutes
(`LOCAL_FLEET_KEEP_ALIVE_MS`), the most `fetch` honors by default, with no bridge
change. Short-lived clients, such as hook and catalog-report processes, still
prove each of their connections once.

## Clankie's Claude foreground launcher

`native-process-proof --claude-processes SHELL_PID WRAPPER_PID CLAUDE_PID`
returns three records in that order. It additionally requires the wrapper to
be the shell's direct child and foreground group leader, Claude to be its direct
child in the same group, and the wrapper's kernel argv[2] to be exactly `claude`.
All lifetimes, executables and retained argv are bracketed as in process mode.
The fixed subcommand is checked without returning later arguments or environment.

The service accepts this mode only for a Herdr Claude observation when the
wrapper's kernel executable and canonical argv[1] match the service's installed
Node + `clankie` launcher. Claude must match the installed Claude executable (or
the existing supported adjacent release). Herdr's foreground list supplies only
bounded candidate hints, never authority. Generic wrappers, other subcommands,
non-child processes, changed lifetimes and ambiguous matches refuse. The admitted
process is Claude, so subsequent socket ancestry checks still require the real
harness or the existing separately proven private-seat path.

## Shell and foreground process observations

```sh
native-process-proof --processes SHELL_PID AGENT_PID [--diagnostics]
```

Success returns one JSON object, with the two processes in the supplied order:

```json
{
  "schemaVersion": 1,
  "processes": [
    {
      "pid": 123,
      "ppid": 122,
      "uid": 501,
      "birth": ["1791220000", "123456"],
      "executable": "/absolute/path/to/executable",
      "argv": ["argv[0]", "argv[1]"]
    }
  ]
}
```

The example abbreviates the array; successful output always contains exactly two
records. Both require full `PROC_PIDTBSDINFO` observations with effective UID
equal to the body's `getuid()`, a live 64-bit process, and an absolute
`proc_pidpath` executable. Birth seconds and microseconds remain decimal strings.
Each executable and argument must be valid UTF-8; JSON escapes controls, quotes
and backslashes. Each retained argument is bounded to 4096 bytes. The `argv`
array contains exactly the first `min(argc, 2)` arguments, including empty
strings; fewer arguments yield a shorter array, and zero arguments yield `[]`.
Later arguments and environment values never enter output or diagnostics.

`KERN_PROCARGS2` supplies the argument bytes. The helper reads the bounded kernel
argument area, verifies size observations and erases its temporary buffer. It
uses the LP64 executable-path alignment established by XNU's
[`exec_extract_strings`](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_exec.c)
and [`sysctl_procargsx`](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sysctl.c)
to locate arguments; skipping all NUL padding would incorrectly consume an empty
`argv[0]`. Unsupported widths, truncation, malformed data, inaccessible or exited
targets, and exceeded bounds refuse the entire observation with zero stdout.

The helper captures both processes twice, brackets each executable/argument read
with full process identities, compares executable and argument observations, and
rechecks both identities before emitting. It shares the bounded attempt/time
limits with socket mode, without scanning unrelated processes. The body repeats
the batch around current Herdr and binding checks; executable observations do
not grant membership by themselves. There is no `ps` or `lsof` process fallback.

Kernel argument observations read the process's user stack. They do not provide
immutable exec-time attestation or an atomic snapshot of both processes.
Repeated reads refuse observed changes, but cannot establish that no change
occurred and reverted between observations.

## Registered process lifetime

```sh
native-process-proof --birth PID [--diagnostics]
```

This narrower observation returns
`{schemaVersion:1,process:{pid,uid,birth:[seconds,microseconds]}}` using the same
decimal-string birth contract. It requires two agreeing full same-user BSD
snapshots of a live process. It reads no executable, arguments or ancestry and
does not require an LP64 argument layout. The body can compare this fresh
lifetime with its own existing private-process registration; neither a supplied
PID nor the observation alone grants authority. Exit, changed identity,
unavailable data or exceeded bounds refuses the entire observation.

## Process working directory

```sh
native-process-proof --cwd PID [--diagnostics]
```

This PID-local observation returns
`{schemaVersion:1,process:{pid,uid,birth:[seconds,microseconds]},cwd}`.
Darwin reads `PROC_PIDVNODEPATHINFO` through libproc; Linux reads `cwd` through
its pinned proc-directory descriptor and includes `kernelIdentity` as in birth
mode. Two agreeing cwd reads are bracketed by fresh, live same-user process
identities. Missing, invalid UTF-8, changed, inaccessible or exited observations
refuse; paths are JSON-escaped. The existing helper/transport bounds and Linux
host/procfs checks apply. No `lsof`, cwd cache or roster path supplies a fallback.

Project workspace resolution still checks current canonical paths, settings and
native process proofs before publication. Its five-second membership deadline
is unchanged. Four serial `lsof` reads could consume roughly ten seconds under
load (VUH-2299); this narrower kernel observation removes that setup cost while
retaining fresh cwd reads at both checkpoints. Cwd alone grants no authority.

## Cleanup cwd census (Darwin)

```sh
native-process-proof --cwds [--diagnostics]
```

Cleanup reads a fresh bounded kernel process inventory and vnode cwd paths,
returning `{schemaVersion:1,uid,cwds}`. Every live process in the effective-user
inventory must be observed; readable other-user paths are included too. Each
path is bracketed by matching process lifetimes, and a second account inventory
detects new or unobserved live processes. Churn retries within the existing
200ms attempt / 600ms total budget. An account process that execs a setuid
program such as `/bin/ps` leaves the account after it was listed; when a fresh
kernel read confirms another effective user, its refused read is churn and the
retry re-lists without it (VUH-2937). Inaccessible account processes, incomplete
inventories and oversized output refuse the census.

Integration and worktree-cache reclamation request this census again before
each removal. No snapshot is cached across removals. This replaces repeated
`lsof` filesystem setup without relaxing live-process protection. Linux keeps
its existing `/proc` cleanup observer.

## Reattached Codex server observation

```sh
native-process-proof --codex-server PID HEX_ENDPOINT HEX_CANONICAL_SOCKET_PATH [--diagnostics]
```

Success returns the same birth-only schema as `--birth`. This PID-local guard
requires a live same-user LP64 process, the actual `proc_pidpath` executable
basename `codex`, and kernel arguments ending exactly in `app-server`, `--listen`
and the decoded endpoint. The endpoint starts with `unix:///`; the supplied
canonical socket path is absolute. Both inputs are hex-encoded UTF-8 without
NUL or control characters, bounded by the SDK's Unix socket path capacity
(103 pathname bytes plus the terminating NUL; the endpoint also allows its
seven-byte `unix://` prefix). Hex encoding preserves spaces and non-ASCII paths
through the private ASCII transport. The caller resolves the canonical path;
the helper compares it to the kernel's local bound address.

The named process must hold a listening `AF_UNIX` stream socket with that exact
local `sun_path` and `SO_ACCEPTCONN`. The helper repeats full process birth,
executable, exact argument-tail and owned descriptor observations, comparing the
same descriptor, socket and PCB identities and local path before emitting.
Duplicate descriptors in that process are allowed; distinct matching listener
identities, disappeared descriptors, unavailable observations and changed
lifetimes refuse the whole proof. No arguments, endpoint or path enter its output
or fixed diagnostics. The argument buffer is erased and environment values are
never parsed.

This guard retains the existing named-listener boundary for recovery. It does
not establish global Unix socket ownership or bind the filesystem vnode/inode,
and repeated observations cannot rule out an intervening change and reversal.
The body's separate fresh TCP ownership/ancestry proof, current private-seat
checks and actual Codex RPC thread check still decide admission. There is no
`ps` or `lsof` recovery fallback.

## Body-owned persistent transport

```sh
native-process-proof --serve
```

This mode serves the body's private stdin/stdout pipes. It has no listener,
authentication socket, service registration or global daemon. EOF exits. Keeping
one owned child alive avoids starting a process for each observation; it does
not retain a proof, owner, ancestry, process record or admission decision.

Each request is one LF-terminated ASCII line: a positive, strictly increasing
JavaScript-safe integer ID followed by the existing CLI arguments, separated by
single spaces. The maximum line is 4096 bytes including LF; the maximum is ten
tokens including the ID. No quoting, embedded NUL, control characters, non-ASCII
tokens, repeated spaces or partial final line is accepted. Supported argument
tokens are flags, decimal ports/PIDs/births, colon-separated socket identity
and the bounded hex endpoint/path used by Codex recovery.

```text
1 --processes 123 124
2 45000 34000 --diagnostics
3 --birth 123
4 --codex-server 124 756e69783a2f2f2f746d702f736561742e736f636b 2f746d702f736561742e736f636b
```

Each completed job returns exactly one JSON line:

```json
{ "id": 1, "ok": false, "result": null, "stderr": "Native process proof unavailable\n" }
```

A successful `result` is the existing complete socket, process-batch or
birth-only JSON object.
A refused proof has `ok:false` and `result:null`. The `stderr` string contains
only the same generic failure and requested diagnostics as the CLI (including
private failure-time ancestry facts).
Malformed framing, non-monotonic IDs, stream errors or exceeded output bounds
close the channel with generic stderr; no partial proof grants access. Valid
framing with invalid proof arguments returns a refusal and permits the next job.
The entire encoded response is bounded to 1 MiB.

Every job executes the same fresh proof functions and resets clocks, attempts,
budgets and diagnostic flags. Socket mode still performs its complete process/FD
census, requires one distinct socket owner and revalidates exact lifetime and
socket identities; a newly shared descriptor refuses even after an earlier job
succeeded. Process mode repeats the same full BSD/path/argument observations.
All proof modes retain the 32-scan ceiling and independent per-job 600 ms total
bound; socket scans also bound their PID-local retries within those clocks.
Request and captured output buffers are erased and freed after each job. The
body bounds the waiting queue to 128 jobs and starts each job's 1 s timeout at
active dispatch. Waiting time is not a 1 s enqueue deadline; an uncanceled
queued request can wait behind other bounded jobs. Canceling an active caller
drains its exact native frame and discards its result before releasing that
caller's permit, then serves independently queued jobs through the same child.
Canceling a queued job removes only that job. An actual malformed protocol,
stalled active job or failed child still closes the helper and refuses all
pending jobs. These transport controls do not substitute for fresh kernel or
current Herdr checks.
The classic one-shot CLI stdout/stderr contract remains unchanged.

## Build

```sh
pnpm fleet-proof:build
```

Source `dev` and `start` run this preparation before the body starts. The helper
is built under ignored `.local/fleet-proof/`, outside the request path. An
unchanged source, architecture, flags and binary digest reuse that build.
macOS releases ship the signed binary at `libexec/local-fleet-proof`. Linux
preparation atomically copies the executable Python helper to the same location;
Linux release assembly includes it beside the bundled Node and Herdr runtimes.
Installed users need no compiler. Linux hosts need the system Python described
above; Windows remains unsupported by this admission helper.

## Verification

```sh
FLEET_PROOF_NATIVE_TEST=1 pnpm exec vitest run --config vitest.config.ts \
  apps/clankie/test/local-fleet-proof.integration.test.ts
```

This opt-in integration test uses actual HTTP sockets, the compiled helper and
an isolated real Herdr daemon with owned shell panes. It exercises membership,
foreign panes and processes, revocation, socket exit, changed birth pins and
shared descriptors; the fixture records cold and repeated proof durations in
`.local/proof-cost/`. Twenty repeated requests on one connection must run no
census. A proven owner that hands its connection to a child and exits must be
refused on that same connection (`owner_mismatch` against the pinned owner), and
a connection shared before its next full proof must be refused with
`multiple_owners`. Legacy socket-scan commands are denied by the test while
real Herdr commands run. No provider credentials or live fleet are needed.

The stale-birth case uses a birth read from a different real process with the
same expected PID as the live client. It proves refusal of a stale lifetime pin
at the real `LocalFleetLink` HTTP boundary, with no forwarded effect. The test
then confirms the original PID has exited and admits a new process with a new
birth and socket. This tests the reuse guard without forcing numeric PID recycling.

## Refusal diagnostics and retry

Server-owned opt-in diagnostics report fixed proof stages and native reason
codes, errno, attempt and retry status. The helper's `--diagnostics` writes these
to stderr; its successful stdout schema and generic failure stderr remain the
default contract. An ancestry failure additionally records private `ancestryFailure` facts:
walk/recheck phase, zero-based chain position, failed PID, claimant PID/birth pin
and its freshly checked status (`same`, `exited`, `changed`, `unavailable`).
An empty `KERN_PROC_PID` result is classified as ESRCH; a separate native exit
check confirms absence before it can trigger the re-walk.
`caller_exited` confirms the claimant exited; `ancestor_exited` confirms an
intermediate exited while the same claimant lifetime remains live. Unknown and
changed identities remain distinct fail-closed observations. The body joins
these facts to the existing private request ID. Only fixed reason labels enter
metrics or alert text; no PID/birth, endpoint, command, path, environment or
credentials enter public counters. Diagnostic callbacks cannot change admission.

Real native scheduled-exit evidence supports one ancestry re-walk per job when
an intermediate is confirmed exited and the original claimant lifetime is still
live. It spends the existing scan/job budgets, revalidates PID/birth/user and
socket identity with bracketed full owner reads, and discards the failed chain.
It then walks and rechecks the current claimant's entire ancestry independently.
A second intermediate exit refuses with `ancestor_exited`; confirmed caller exit
refuses with `caller_exited` without replay. Unknown or changed lifetimes do not
trigger this re-walk. The body still proves current membership from the new
facts, takes its second snapshot, and rejects non-members. The old ancestry
never grants authority. `native-ancestry-exit.integration.test.ts` covers the
live claimant, real exits/reparenting, unchanged stale-pin fences and real HTTP
non-member refusal.

The body also forwards opt-in shell/foreground process diagnostics into its
fleet counters. Missing panes retain Herdr's fixed `pane_not_found` classification
at the initial or final proof phase. See [reason coverage](REASON-COVERAGE.md) for
the real-boundary evidence, complete vocabulary contract and explicit OS coverage
limits.

A process can replace a listed socket FD with a non-socket before the kernel
socket query. macOS returns `ENOTSOCK`; like `EBADF`, this requires a complete
fresh observation of that PID, without skipping its uncertain descriptor or
restarting unrelated processes. Sustained churn can exhaust the bounded attempts
and refuse access. A complete census may also succeed during unrelated descriptor churn;
churn alone never implies a mandatory refusal. The HTTP integration retains
either outcome and checks exactly one forwarding effect for verified admission,
zero for refusal, unchanged owner/socket identity, and recovery after churn stops.
A second real PID sharing the client FD still refuses all requests during churn
with zero forwarding. The
opt-in `apps/clankie/test/native-proof-churn.integration.test.ts` also observes
real unrelated process births/exits, distinct PIDs sharing a connected FD during
descriptor churn, stale owner/socket pins, and a live owner's changed ancestry
after its original parent exits. It retains every native observation under
`.local/project-proof/churn/native/integration/`; fresh ancestry facts do not
independently authorize membership in that former parent's pane.

The manual `native-admission-scheduled-churn.integration.test.ts` schedules real
births after `PROC_ALL_PIDS` and real FD closure after `PROC_PIDLISTFDS`. Its
separately compiled fixture wraps scheduling calls but returns only actual
libproc results. It requires HTTP admission at both native checkpoints within
2 s, without restarting the global scan, and rejects outsiders, another pane,
shared client FDs and a second owner born between PID lists. The shipped helper
has no test controls. Evidence stays in `.local/admission-churn/`; see the
[bounded-admission report](../../docs/testing/2026-10-06-admission-churn/README.md).

An exact HTTP 503 `fleet_admission_unavailable` means current proof is
unavailable and that request was refused before dispatch. Claude and Codex
bridges retry once after a short wait; persistent uncertainty asks the worker
to retry shortly, then report it to the lead. A definite non-member gets HTTP 403
`local_process_membership_required` and should ask the lead to inspect admission.
Neither bridge retries that refusal. Uncertain writes or lost replies must
reconcile their original receipt. A later refusal does not establish that an
earlier uncertain operation never ran.
