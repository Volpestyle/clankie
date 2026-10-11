# VUH-2090: bounded integration isolation and withdrawal

Tracks: [VUH-2090](https://linear.app/vuhlp/issue/VUH-2090).

Compatible batches now contain at most three requests. A failed shared gate
queues individual fresh gates, alternating with new waiting batches. A failing
member needs a shared attempt and one individual attempt for attribution.
Restores keep their admission-order barrier. Main moving into checked inputs
still requires the existing bounded re-gates; exact-tree landing checks stay in
place.

An owner can withdraw a waiting request or an active isolated retry before
landing. An in-flight gate finishes, but a tree containing withdrawn input
cannot land even with a zero-exit gate. Surviving requests need a fresh tree and
gate. Durable receipts retain the actor, reason and original request identity.
The first non-isolated gate and a landing already under way refuse cancellation.

Status exposes the isolation chain, scheduled batch position and a conditional
completion ETA from up to eight measured jobs in the running queue process.
Without measurements the estimate is unknown. The CLI returns these fields;
`/integrate` renders the chain and ETA. API, human docs and the shipped launcher
skill describe recovery.

## Evidence

The real CLI/API/Git-process regression parks gates against disposable local
bare origins. Nine approved inputs establish the batch cap, green progress
before isolation finishes, active and waiting withdrawals, durable reload, a
zero-exit withdrawn gate with no push, and surviving code reaching origin.
Its emitted `vuh-2090-progress-evidence` records actual heads, gate trees,
receipts, chain and ETA. This is a local protocol/process proof, not a live fleet
deployment or a measured hour-long production queue.

The existing failure-attribution case now observes two attempts for the bad
member, five real gates overall, both healthy requests landed and no broken
input in origin. A separate real-origin regression proves older isolated
requests finish before a restore, and the later forward change gates on the
restored tree. The existing main-move revalidation test pins retained held
attestations and fresh re-gating.

Negative control: temporarily disabling both withdrawal landing fences made
the regression fail on a **confirmed push of the withdrawn input** to its
owned test origin. The source was restored before final checks. The failed
control and passing runs are retained in the archived bundle.

The initial broadened run had **59 passes and one glyph failure** with
`TERM=dumb`. The same five consumers subsequently passed all 60 tests under a
normal terminal capability. Main's VUH-2088 fix (`24c632b60`) explicitly pins
and restores the glyph test's capability; this branch reuses that change.
The original nonzero result is retained separately from passing runs.

After refreshing to `origin/main` (`8c93bbc09`), the same five affected files
passed **61 tests** under the native tool environment, including main's added
consumer coverage. Service and TUI typechecks, formatter and focused lint passed.
Every heavy command ran through `clankie heavy --`. The lead assigned the root
landing gate to integrate; it was not duplicated locally.

The PC gate was interrupted by the lead's service deployment after a WSL kernel
wedge; no remote gate pass or landing is claimed. The branch was refreshed onto
`84e6f9dee`, preserving its public stall observer and renaming this change's
private status projector to `requestProgress`. All **63 tests** in the same five
affected files and both typechecks passed on that tree. The refreshed source,
logs and interrupted receipt are in `local-resubmit-proof.json` in the manifest.

Final focused checks and landing evidence are attached to the issue. Raw logs,
observations and the checked source snapshot are keys in the `proof.json`
object listed in [evidence.json](evidence.json).

## Remaining gaps

This change does not abort a running gate; withdrawal waits for that owned
command to finish and prevents its tree from landing. ETA remains conditional
on current jobs and measured durations: pressure, new arrivals, remote fallback
and main moving may change it. Service restart interrupts work and resets timing
samples. A cancelled input already landed by a different request is not undone.
No live fleet queue was changed or restarted for this proof.
