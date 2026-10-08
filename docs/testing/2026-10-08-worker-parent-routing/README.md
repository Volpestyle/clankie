# Parallel-load fixture readiness — VUH-1851

The reported failures were the attached-workspace receipt alert (two lanes) and
parent-session retirement during route discovery. The original fixture used one
`setImmediate` after starting `/v1/seat/events` as evidence of attachment.
Authentication reserves driver intent before native census and policy preparation;
that tick does not prove the mailbox's poll has started.

Disposable probes on `be4a4cc5`, with only raw Herdr/kernel observations substituted:

- Holding native census preparation across the tick made the helper return while
  the real `seat_bridges` API reported `disconnected`.
- Holding the unfinished poll, then arming the existing second-census barrier,
  let the poll consume its first count. The report's first discovery census took
  the second. After abort/reset, the report correctly chose the unlinked-parent
  fallback and returned `stored`, rather than exercising retirement of an
  already-selected parent route. The original test expected a different ordering.
  [Curated trace](controlled-retirement.json) records that reproduction.
- After taking a report and replacing the service, holding the old lead's native
  preparation made its helper return with only retained presence. Reconciliation
  retained the original route, but immediate abort returned `[]`: actual polling
  had not yet called the unresolved-receipt notifier. This reproduced both lanes'
  missing `seat-delivery-alert` assertion. [Curated trace](controlled-alert.json).

The fixture now advertises a unique bridge source hash on each operator poll and
waits for that hash in the existing `seat_bridges` API. This observes actual mailbox
poll preparation, including after a replacement service loads old presence.
Only then may tests start reports, abort a poll, or count subsequent census calls.
Legacy event kinds and owner-origin authority are unchanged. Production routing
and timeouts remain unchanged. The controlled integration regression holds census
preparation and verifies that the helper cannot return before its poll is ready.

## Runtime canary

Rowan’s gate on `06734cb8` (base `be4a4cc5`) recorded three verified samples,
healthy loopback latency (p95 about 6ms), and a 950ms elapsed sampling gap against
the fixture’s 450ms budget. The isolated unchanged file passed. This establishes
that the fixture’s real scheduler timeline could trigger the real safety policy;
it does not identify which competing process delayed that historical sample.

`RuntimeCanary` accepts an optional monotonic clock, defaulting to the unchanged
process clock. The child-process fixture advances this clock at sample boundaries
using its snapshotted interval. Actual HTTP, CPU measurement, timers, durable
holds and update records remain real. A deliberately delayed 900ms scheduling
turn passes with verified health; a controlled 600ms gap still fails against the
unchanged 450ms budget and retains its hold. Production policy is unchanged.
Three four-fork runs passed all 89 tests across canary, parent routing, conversation
seat/reset and receipt files, including all 22 canary cases.

## Discord overlay

The fixture uses private homes and ephemeral loopback ports; no shared fixed
listening port was found. Holding the real `/v1/discord/settings` reply made the
old one-second `vi.waitFor` reject while the editor still had focus. Releasing
that same successful reply produced the expected real overlay. This proves the
helper can fail solely because valid preparation takes longer than its deadline;
the historical gate log does not identify which particular request was delayed.

The shared fixture helper now observes real `requestRender` calls after the setup
flow focuses its overlays. Its call-through observer preserves rendering and
checks both component type and displayed prompt. Actual command completion before
that prompt is an explicit failure. API and whole-test deadlines stay unchanged.
The regression holds a real response beyond the old deadline, proves the helper
stays pending, releases it, and completes the real setup flow.

All three failures involve timing assumptions in fixtures, but at different
boundaries. Existing mailbox identity and renderer events prove readiness;
a controlled monotonic clock proves short canary policy windows independently of
scheduler load. No generic retry policy or shared timeout increase is needed.

## Verification

The parent-routing fix first passed 20 consecutive four-fork runs: 41 target cases
and 26 companion cases per run (1,340 passing tests total). Three canary-focused
loaded runs then passed 89 cases each, and the whole Discord file passed 10/10.

Expanded verification passed **20 consecutive completed four-fork rounds**, each
running all 41 parent-routing, 22 canary, 10 Discord and 15 receipt cases:
**1,760 passing tests**, with no exclusions or case retries. After round 12 James
requested shorter permits so other lanes could interleave. The in-flight round
was terminated and excluded, then restarted as round 13. Remaining rounds ran in
four two-run permits, releasing and rejoining the normal queue between chunks.
Fixture inputs stayed unchanged; [report counts and source hashes](verification.json)
are extracted from the successful Vitest JSON reports.

Commands: `clankie heavy -- sh .local/vuh-1851/combined.sh` (first 12 completed
rounds), then `clankie heavy -- sh .local/vuh-1851/chunk.sh N N+1` for rounds
13–20. Each round used `pnpm exec vitest run --config vitest.config.ts
--maxWorkers=4` with the four complete files above. The ordinary 30-second test
and hook deadlines remain unchanged. No live provider turn, existing owner store,
simulator or game body is used.

After a clean rebase onto `475651a6`, dependency refresh and `pnpm docs:check`
passed (555 Markdown files and 10 public pages). `clankie heavy -- pnpm
check:landing` passed all static checks, **30 typecheck tasks**, and **1,142 tests**
(5 skipped) across **152 passing files** (2 skipped, 154 selected). No exclusions
or scoped landing exception were used. All five verified source hashes stayed
unchanged after rebase. No deployment, hold override, restart or live OS setting
was performed.
