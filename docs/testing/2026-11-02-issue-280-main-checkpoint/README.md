# Issue #280: main checkpoint close-out proof

[Issue](https://github.com/Volpestyle/clankie/issues/280) ·
[PR](https://github.com/Volpestyle/clankie/pull/287)

On base `38c302fc2911cfe3ec7f0a8eef7b6e8a1c1d2759`, the two repro assertions
in commit `b41a33dc5c43e8200e414745d6f2bb526c6a0bdf` failed: pane close returned
`closed`, and lead Done wrote `leadCompletion`, despite the supplied red,
unfiled checkpoint observation. The pre-fix receipt records those results;
it is a summary of runner output, not a native pane recording.

The final tests use a real Git DAG (including a parallel main commit before the
merge and a later main commit), the production GitHub HTTP transport, persistent
tracker and evidence stores, and the existing native pane boundary fixture.
They prove red holds pane retirement, auto-tidy, connector close and lead Done;
linking a bug releases them. They cover green, cancelled, running, missing,
unreachable and descendant-covered results, plus absent checkpoint readers.
The connector proof also exercises its session adapter and typed response schema.

The final focused command selects these eight files through `clankie heavy --
pnpm exec vitest run`:

- `packages/work-items/test/main-checkpoint.integration.test.ts`
- `packages/work-items/test/lead-closure.integration.test.ts`
- `apps/clankie/test/pane-tidy.integration.test.ts`
- `apps/clankie/test/connector-close.integration.test.ts`
- `apps/clankie/test/main-checkpoint-service.integration.test.ts`
- `apps/clankie/test/tracker-lead-closure-routing.integration.test.ts`
- `packages/work-items/test/backends.test.ts`
- `packages/work-items/test/write-deltas.integration.test.ts`

`verification.log` records **130 passing tests across 8 files**. `live-observation.json` is a
read-only observation using the new reader and the existing authenticated `gh`
route against PR #279's actual worker HEAD. It returned `covered` after #286
was filed; that means the close-out condition was accounted for, not that main
was green. No installed service restart, live pane retirement, CI repair or
owner acceptance was performed. The HTTP Actions/issue data in the regression
proof is controlled fixture data; the Git history and stores are real.

[Raw receipts archive](clankie://evidence/sha256/30c80905db757cd1d8dce73a144998fca967d10e9974de325765ea90b3a75b72) contains the before/after receipts, live observation and implementation patch at proof time. The [manifest](evidence.json) records its upload.

## Lead review corrections

Against `579fc6324`, the added no-checkpoint-repository and research-worktree
assertions both failed: each received `main_unknown` for an unrelated/missing
main result. The corrections distinguish repositories with no checkpoint jobs
in 20 recent main push runs, and skip checkpoint accounting when the worker
made no commits beyond its hire/worktree base or Git fork point.

The follow-up focused run passes **133 tests in 7 files**, including no-checkpoint
and no-main-run repositories, actual research worktrees, recorded start bases,
cache expiry and connection isolation. A 35-pane concurrent sweep makes one
Actions run observation and five bug-search requests, with no repeat requests
while cached. A different HEAD resolving to the same merge shares its result.
A newly filed bug appears after three minutes; HTTP 429 remains unknown and is
retried only after expiry. These are production HTTP/Git boundary tests with a
controlled clock, not live GitHub rate-limit exhaustion.

[Review correction receipts](clankie://evidence/sha256/419e0e14389f6bd99f32ca69c947e40da330a0533462d7ba5a9c714067285e6b)
include the final 22-case verbose regression run, the 133-test result summary,
focused typecheck reports and implementation patch.
