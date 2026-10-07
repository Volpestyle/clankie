# VUH-1762: full gate stability and timing

Vale's candidate (`vale/vuh-1762-gate-stability`, `17e4268b`) was finished and landed
through the queue from fresh `origin/main`. Full gate results are retained in the
owned worktree's ignored `.local/vuh1762/` and reported on
[VUH-1762](https://linear.app/vuhlp/issue/VUH-1762).

## Failure classification

[Historical receipts and every named failure](historical-failures.json) retain
source log hashes and frozen revisions from Pell's read-only gate directory.

| Attempt | Classification                     | Cause and disposition                                                                                                                                                                                                                                                                                                               |
| ------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14      | Real fixture bug                   | All 16 OpenCode failures share an unsupported new checkout-admission command. Pell's `2a138169` executes the exact canonical program against the fixture directory; already in his integration batch.                                                                                                                               |
| 15      | Real test bug                      | Checkout admission adds a third authority check, while the assertion still expects two. Pell repaired it in `a1c5af88`, which is on main and names all three boundaries; Vale's looser boundary-order rewrite was dropped when landing.                                                                                             |
| 16      | Clean                              | 7,100 TypeScript tests, 124 Vox tests and IPC smoke passed. Native-boundary stderr also appears in this clean run; that line alone does not establish a failing test.                                                                                                                                                               |
| 17      | Real static failure                | Unused room-fork validator export. Pell's `8618028b` carried as `8179e5b4`; runtime parsing is unchanged.                                                                                                                                                                                                                           |
| 18      | Environment-dependent cancellation | No test failure reported. Verified owned runner intentionally received SIGINT when origin advanced; `stopped18.json` records it.                                                                                                                                                                                                    |
| 19      | Real static failures               | Three unused provider/release helper exports. Pell's `1c1a552f` carried as `d01fcfc2`; runtime behavior is unchanged.                                                                                                                                                                                                               |
| 20      | Environment-dependent cancellation | No test failure reported. Verified SIGINT after origin advanced; `stopped20.json`.                                                                                                                                                                                                                                                  |
| 21      | Real formatting failure            | `scheduled-update.ts`; already fixed on main by `47cbe333`.                                                                                                                                                                                                                                                                         |
| 22      | Test failure plus cancellation     | Late-ACK delivery failed before the run was intentionally interrupted for origin advancement. The final assertion stack is absent. The candidate removes an inferred fixture detach race by waiting for the native receiver's HTTP poll to attach before posting new activity, preserving both restart cases and replay assertions. |
| 23      | Flaky test                         | Backoff test observed `[6,10,20]` instead of `[5,10,20]` seconds. Its bytes match main. Fake time advanced while real service I/O remained unsettled; production starts backoff after failure settlement. The candidate freezes fake time during settlement and checks exact 5/10/20-second delays plus no early retry.             |

No test is quarantined. Cancellation receipts do not justify removing coverage.
The remaining native-delivery cause is an inference from its fixture lifecycle;
the interrupted original log cannot prove the exact failing assertion.

The backoff repair is independently harvestable as
[`66f2b0ee`](https://github.com/Volpestyle/clankie/commit/66f2b0ee14042c9ff05fb569c06877f9d4ca799b).
It changes only `native-seat-service-fallback.integration.test.ts`. Five
consecutive focused executions passed with that file unchanged. The local
`backoff-five-receipt.json` retains source/report hashes and all five result
paths; the final two executions selected just the backoff case.

## Profile and checks

The completed historical gate16 spent 1,243.79 seconds in Vitest: 907.35 seconds
of tests, 282.05 seconds of imports, 8.52 seconds of transforms and 3.38 seconds
of setup. Typecheck took 8.542 seconds with 28/29 Turbo cache hits. Formatting
reported 0.917 seconds and Clippy 0.24 seconds. The before full-gate envelope
from the frozen receipt timestamp to its final receipt mtime is 1,264.34 seconds
(21m04s); that envelope includes preflight and any admission wait, which the old
log does not time separately. Gate23's larger batch took 1,392.39 seconds in
Vitest, with 1,028.60 seconds of tests and 306.21 seconds of imports.

The cheap win is two bounded, isolated forks, preserving every suite and test
selection. The focused four-file run passed 41/41 in 40.09 seconds wall time for
66.50 seconds of test execution. Both timing-sensitive files passed twice more,
14/14 each, in 32.30 and 30.68 seconds. Service and TUI typechecks, scoped lint
and formatting passed. Every heavy command used `clankie heavy --`.

Measured full candidate gate (`1eaf00ed` on `22e013b0`, 2026-10-07, through
`clankie heavy`): every step exited 0 and the whole gate took 781 seconds (13m01s),
against the historical ~1,264-second envelope. Vitest reported 720.83 seconds of
wall time for 7,165 passed tests in 778 files (46 manual skips), versus 1,243.79
seconds in gate16 and 1,392.39 seconds in gate23. Summed test time (1,063.71 s)
and imports (317.39 s) are comparable to before; the two forks overlap them.
Static steps took 41 seconds in total and typecheck took 14 seconds. Inputs differ
from the historical gates (newer main, warm Turbo cache), so the comparison is
indicative, not a controlled benchmark.

The full-gate profiler executes every `pnpm check` step sequentially, with
JUnit reporting enabled and Turbo typechecks serialized inside the permit.
It will retain each step's elapsed time, the whole gate duration, JUnit test
measurements and logs under `.local/vuh1762/gate-1/` and `gate-2/`.
Admission wait is outside those execution timings. Full candidate gates are
pending the fleet's single full-gate slot. Acceptance still requires two
consecutive clean gates on `origin/main` after the lead lands the repairs;
focused candidate results do not satisfy that requirement.
