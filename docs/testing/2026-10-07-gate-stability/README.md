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
