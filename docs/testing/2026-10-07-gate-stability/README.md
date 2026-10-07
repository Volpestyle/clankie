# VUH-1762: finishing the full gate

Follow-up to [the historical classification and first speedup](../2026-10-06-gate-stability/README.md).
The assigned baseline is `4b9c935fe0ecf711ae41be7673c302479380dada`.

## Causes and changes

- The 137 queue failures were environmental: inherited long temporary paths
  overflowed Unix socket paths. The queue launcher was already fixed; ordinary
  Vitest still inherited its caller's `TMPDIR`. Every suite now gets a short,
  private temp root, and children inherit `TMPDIR`, `TMP` and `TEMP`. The existing
  isolation integration regression fails with the original setup and passes all
  three owner-store scenarios after the fix, including real socket traffic,
  child inheritance, permissions and cleanup. HOME/store guards remain intact.
  Inspected service and claim fixtures bind OS-assigned loopback ports; no port
  collision was demonstrated. The full concurrent runs remain the broader check.
- Today's `chunk-ab` failure was deterministic consent-message assertion drift:
  expected `not installed on pc`, received `not installed in pc`. It was already
  fixed by `4b9c935f`; its unchanged current suite passes 17/17.
- The first current gate stopped at formatting errors in the docs builder and
  remote-hire evidence. Those are fixed without semantic changes.
- Later main changes exposed two static-boundary omissions: the root profiling
  launcher resolved the service's `tsx` loader, but knip attributed it to the
  root package; its implementation now belongs to the service workspace with
  the same root CLI. The shipped worker admission declaration is registered as
  an entry point, matching the existing worker declaration entries.
- The first test attempt stopped after two deterministic fixture failures. The
  profiler fixture now copies both the root launcher and its relocated helper,
  preserving real `tsx` startup, signal forwarding and CPU-profile flush checks.
  The connected-call refusal fixture expects the newly shipped admission
  guidance exactly, retaining zero dispatch and no replay assertions. Both
  complete files passed 127/127 after these fixes.
- A complete TypeScript run on `100616af` found five further fixture failures:

  | Test                   | Cause and repair                                                                                                                                                                 |
  | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Fleet editor           | Its positional selections omitted the new gate preset, so the editor cancelled before saving. Select the preset and assert its persisted gate with all original preferences.     |
  | Harness doctor         | The secret sentinel `private` matched legitimate Darwin `/private/tmp` paths. Use a distinct secret sentinel; retain the exact secret-redaction and native freshness assertions. |
  | Claude plugin manifest | The expected four hook events predated the nine-event owner-question channel. Assert the exact current events, commands, timeouts, matchers and asynchronous flags.              |
  | Fleet hook route       | `Notification` became a valid event. Assert it is recorded; unknown events, malformed sessions, extra fields and unauthorized bodies remain rejected without dispatch.           |
  | Local fleet admission  | A closed connection now returns the intentional retryable 503, distinct from revoked live membership's 403. Assert its error/header and zero proof/provider calls after closure. |

  This failed run retained 7,294 passes, five failures and 49 existing manual
  skips in 814 files. It took 532.10 seconds including an 87.99-second typecheck
  (8/29 cache hits); Vitest took 433.73 seconds. It is failure evidence, not a
  clean gate. Focused repairs preserve every existing suite and boundary.

- Minecraft claim integration coverage drives its existing poll timers instead
  of sleeping through each three-second interval. HTTP and credential persistence
  remain real. All seven outcomes and exact request counts, cancellation, expiry,
  retry and persistence assertions remain.
- Vitest now overlaps four isolated forks instead of two. Its selected suites,
  isolation, fork pool, timeouts and zero retries are unchanged. Evals remain
  explicit manual runs; push/PR CI remains narrow.

## Timings and comparability

| Measurement                                        | Before              | After                                     |
| -------------------------------------------------- | ------------------- | ----------------------------------------- |
| Historical whole gate                              | 1,264.34 s          | First landed two-fork candidate: 781 s    |
| Historical Vitest                                  | 1,243.79 s          | First landed two-fork candidate: 720.83 s |
| Same four representative suites, 55/55 passed each | Two forks: 79.642 s | Four forks: 46.003 s                      |
| Same seven tunnel claim outcomes, test execution   | 46.986 s            | 0.730 s                                   |

The representative selection is `linear-wake-receipts.integration.test.ts`,
`opencode-fleet-lifecycle.integration.test.ts`, `hired-catalog-bridge.test.ts` and
`mcp-receipts-integration.test.ts`. Both measurements use the same checkout,
dependencies and test bytes, through `clankie heavy`; reported execution times
exclude admission wait. Four forks save 42% on this selection, not a claim about
whole-gate speed until full measurements are available.

Today's chunks select only 277 files and 2,616 tests; their summed 279.71 seconds
cannot be compared with the historical full selection (796 files including
manual skips). No missing chunk coverage was removed from the full gate.
The historical candidate spends 1,064 seconds in tests and 317 seconds in imports;
setup is only a few seconds. No redundant TypeScript suite runs in `pnpm check`.
Static checks and typecheck were about 55 seconds; parallelizing these would add
compiler contention for little benefit.

Raw focused evidence is retained in this worktree under `.local/vuh1762/`:
`timing/{two,four}.json`, `isolation/{before,after}.log`, `claim/` and `narrow.log`.
Full gates and their per-step receipts are recorded after landing on main.

## First complete pair attempt

The first clean full gate on `350b74125c5c67c56925a04dccb8f10d9d72e0f1`
passed every step in 535.58 seconds (8m56s). Vitest took 424.83 seconds:
796 passing files, 7,322 passing tests and 49 existing manual skips. Vox passed
124 tests and the native IPC smoke check. Typecheck passed all 29 packages in
79.30 seconds with 8 cache hits. This is 58% less whole-gate execution time than
the historical 1,264.34-second baseline, despite a larger current selection.

The next gate fetched current main `d57b74c288c08763cac942acbbcd6fa3ed303fa0`.
It failed in 509.38 seconds: Vitest took 422.50 seconds, with 7,329 passes,
three failures and 49 existing manual skips. Static checks and all 29 typechecks
passed (76.49 seconds, 8 cache hits). Vox and IPC were not reached.
This breaks the required consecutive clean pair.

All three failures were in `device-subscriptions.integration.test.ts`: terminal
assertions saw `committing` before credential/config persistence completed, and
cleanup raced an unfinished write (`ENOTEMPTY`). The failures were reported at
20:48:14Z, before the owner started deploying at about 20:50Z. The fixture uses
an in-process app, a provider bound to loopback port zero and a browser callback
on port zero; it does not contact the live service on port 4310. These were
premature state assertions, not timeout failures. No contemporaneous machine
load sample establishes whether load exposed the race.

[Per-step receipts and raw log hashes](initial-full-gates.json) preserve both
results. Commands execute the complete `pnpm check` selection, serializing
multi-package compilers inside one heavy permit. Admission waiting is excluded.
Raw logs and JUnit reports remain in `.local/vuh1762/final-gate-{1,2}/`.

The subscription fixture repair waits past both `pending` and `committing` for
terminal assertions. Its existing `onModelChanged` callback supplies an explicit
barrier after durable broker/config writes for the admitted-cancellation case.
Teardown cancels pending work, releases held provider/commit work and observes
admitted sessions settle before deleting their files. No production code,
timeout, retry count or provider/authority assertion changes.
