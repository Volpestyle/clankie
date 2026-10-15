# Auto milestone reports — VUH-2286

Tracks: https://linear.app/vuhlp/issue/VUH-2286

Source based on `da8ce5b47f7e9a2c72e4e6f3c88740a56a388970`, 2026-10-15.
Implementation and proof are committed together; the landing check is recorded separately on the issue.

## Result

- A completed parent or declared tracker milestone prompts one combined project status update with media and evidence links. Routine wakes request none.
- Durable claims survive rounds and process restarts, including rename/reopen cycles. Definite refusal permits retry; uncertain delivery stays claimed and unsettled, preventing duplicate asks.
- Subsequent tracker updates link to the original request even after routine rounds. Routine and extra updates have `unexpected: true`. Tracker rebinding cannot satisfy a former tracker's request.
- Velocity starts at the completed milestone. Milestone identities enter the fingerprint; recording a claim does not cause a second wake.

## Inspected proof

`proof.log`: 12 tests passed in two focused files, run through `clankie heavy -- pnpm exec vitest run apps/clankie/test/auto-velocity.integration.test.ts apps/clankie/test/runtime-provider.integration.test.ts --disableConsoleIntercept`.

`proof.log` includes the `Live Auto milestone proof` JSON capture: isolated running captain, actual built-in tracker, native-channel take/ack, HTTP operator route, durable journal, no model calls. The initial routine round requested no post. Closing parent `LOCAL-1` at `2026-10-15T19:48:56.146Z` produced one milestone request. Delivered round `89a13ef4-d213-4c85-94e9-d50ff6fc681e` subsequently linked update `5e56fff0-8696-4137-95af-55c4404ec66c`; another poll produced no duplicate wake. The test authors the tracker post to prove the request/link boundary; it does not prove a model composes the post or media.

The KH2 test replays the captured Linear responses in `packages/work-items/test/fixtures/outcomes/kh2-multiplayer.json` through the real outcome collector. “Shared world” completed 4/4 at `2026-10-15T01:44:38.451Z`: exactly one milestone due despite 16 closures in that cleanup day, and no repeat after restart. This is replay evidence, not a deployed KH2 round.

`proof.log` ends with the independent review: native review findings, their corrections, and final no-blocker verdict.

## Checks

Focused tests: 12/12 passed. Explicit touched-file formatting and lint passed. Required root landing gate follows the implementation commit.

## Gaps and limits

- Deployed KH2 Auto proof is not performed; no runtime restart or deploy-hold change was made.
- VUH-2256's owner-loop setting does not exist yet; milestone cadence is the default. VUH-2284 slice 2 is not used.
- Status-update association uses tracker identity and time; it does not validate authorship or body media/evidence.
- A post-guard exception conservatively keeps an unsettled claim even if native acceptance never occurred. At-most-once request protection does not guarantee receipt after an ambiguous failure.
