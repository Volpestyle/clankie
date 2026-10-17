# Integration census and fixture cleanup (VUH-2346)

The integration tests use real account process censuses. A process starting or
exiting during a scan can make that observation incomplete; an incomplete
observation must never authorize worktree deletion.

A test-only adapter around the actual `processWorkingDirectories` function
retries only incomplete-census refusals for up to ten seconds. Every attempt
performs a fresh real kernel proof, including each pre-deletion recheck. This
covers automatic and explicit cleanup without a repair sweep or a fabricated
observation. All reclaimed-path, protected-tree, live-cwd, external-target and
repeat-sweep assertions remain unchanged. Native proof budgets, product defaults
and test timeouts are unchanged.

Each transport kills its own child on parent exit and removes the exit handler
when the child closes. Shared test teardown also awaits native observer closure.
A real subprocess regression leaves a helper deliberately holding a timer after
its reply, exits its parent without explicit closure, and requires that helper
to disappear. Fixture removal retries late-writer errors with Node's bounded
recursive-removal retries (ten retries, 50 ms backoff); exhaustion still fails.

## Validation

All test, install and formatter/lint commands run through `clankie heavy`.

- Native transport, including the compiled macOS helper: 17 passed, 9.92 seconds.
- Fleet lead rounds: 27 passed, 47.96 seconds.
- Exact automatic-cleanup case: passed unchanged, 28.37 seconds of test work.
- Scoped formatter, lint and `git diff --check`: passed.
- Complete integration file at ambient load: 36 passed, 299.69 seconds;
  measured load ratio 0.857–1.279; no owned native helper remained afterward.
- The contention journal, per-run load observations and root landing-gate
  outcome are retained with the evidence on
  [VUH-2346](https://linear.app/vuhlp/issue/VUH-2346).

Clankie revised the original arbitrary load-ratio threshold: one ambient run,
then ten runs with several copies competing through normal heavy admission,
recording actual load for every run. The proof uses three concurrent workers,
each running the complete integration file in a separately governed command.
No admission limits or machine observations are overridden.

An initial integration attempt ran zero tests because copied dependency links
pointed outside this worktree (`@clankie/skin-spec`). A frozen offline install
repaired the links. That import failure is retained separately and does not
count as a validation pass.

The first executable ambient attempt passed 35 of 36 tests (238.81 seconds,
load ratio 0.79–1.34). Its immediate automatic-cleanup assertion caught a retained
tree after a real census refusal. That exposed the limitation of retrying only
explicit reclamation sweeps. The final adapter covers the real census call
itself, including the automatic path; the failed run is retained separately.

The first focused automatic-cleanup attempt with the adapter reached its
unchanged 120-second timeout after seven successful landings. A contemporaneous
fleet snapshot measured load ratio 3.07 and CPU ratio 1.0 during another seat's
simulator boot. The unchanged focused rerun passed in 28.37 seconds. The timeout
remains a failed attempt, rather than evidence that the entire suite passed.
