# One full job can progress under external load

Tracks: https://linear.app/vuhlp/issue/VUH-2103

Shared `heavyAdmission` permits the FIFO full head when no full lease is held,
the refusal is load only, available memory meets the owner floor, and load is
strictly below twice `maxLoadRatio`. At or above that cap it still refuses.
It keeps the slot ceiling, unknown-observation refusal and ordinary admission rules.
Starting, running and cleanup leases all count as held, so this exception never
admits a second concurrent full job. Light and server jobs have separate budgets
and do not count as full leases. Simulator guards are unchanged.

The proof uses native pressure, private journals, real registered native runners
and real child processes. No dependency is mocked. A private load ceiling uses
the actual native one-minute load divided by 1.5, placing it between the normal
and thrash guards without generating overload. An initially unreachable private
memory floor queues two FIFO waiters; opening that floor starts the first while
the follower stays queued. The first command then exits with a real owned child
still alive: its cleanup lease keeps the follower queued until the child exits.
A separate real arbiter grant remains in `starting` for a live client's native
birth and keeps its follower queued until that exact id/token is released.
Real memory-floor and above-cap load breaches remain refused with no full lease
held. No live policy was changed.

Checked results:

- Final progress/admission/arbiter integration checks: 15/15 passed in 19.09
  seconds. Package typecheck and scoped formatting passed.
- Native progress proof: load ratio 0.871, ceiling 0.581, available memory
  30.3 GiB; one full lease held and one follower queued. The service's sampled
  follower `admits` was false, using the actual shared policy, through running
  and real `leftovers` cleanup. After release, the successor ran alone.
- Starting-grant proof: load ratio 0.802, ceiling 0.549; one starting full
  lease, one queued follower, no second child started.
- Memory proof: load ratio 0.823, ceiling 0.549, available memory 29.3 GiB below the private
  1,048,576 MiB floor; zero held, one queued, sampled `admits=false`, no child
  started.
- Thrash proof: actual native load ratio 0.802 above twice the private 0.000001
  ceiling; zero held, one queued, no child started despite sufficient memory.
- Against the original policy, progress failed because its head never started
  within 20 seconds, and the starting-grant case failed because no grant was
  admitted. Memory and thrash refusal passed. Against the uncapped exception,
  the thrash case failed because its job started. Fixed source was restored
  after both negative controls.

The first focused run passed 11/13: two existing arbiter fixtures expected load
alone to block an empty lane, which conflicts with the approved exception.
With Quill's coordination, those fixtures now hold one real full job and leave
one free slot, preserving their exact FIFO, service-authority and stale-heartbeat
fallback assertions. All 13 then passed; assertions and timeouts were not relaxed.
After Basil's review, the lead approved the strict 2× cap and the starting/cleanup
proofs, giving the final 15/15 focused result.
An intermediate cleanup proof run passed 3/4: it read `arbitration()` during an
in-progress pass, when the getter correctly returns unavailable. The cleanup
check now waits for a completed sampled decision, just as the running check
does, and asserts `admits=false`; the timeout and refusal assertions are intact.
That failure log is retained alongside the final passing run.

The lead approved this one exception. Quill cleared ownership and confirmed
sampled eligibility must follow the shared decision; Basil was informed. No
governor transaction or sampling edits were needed. The exact-tree integrator
gate supplies landing verification; no duplicate local root gate was run.

Raw logs and checked sources are archived in `evidence.json`.
