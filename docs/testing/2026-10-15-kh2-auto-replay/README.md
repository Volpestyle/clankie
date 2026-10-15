# VUH-2287: KH2 historical Auto replay

Tracks: https://linear.app/vuhlp/issue/VUH-2287 and https://linear.app/vuhlp/issue/VUH-2255.

The authenticated, read-only `auto rounds --replay` endpoint reconstructs each
completed local day's issue states from tracker history and reads churn from the
existing origin mirror. It uses the live velocity projection and slice-1 drift
detector. It has no wake, tracker-write, recorded-round-write or pending-drift
consumption path. Project, parent and milestone membership remain current.

## Expected history

VUH-2255's America/Chicago table, with KH2's declared product paths:

| Day        | Product lines | Tooling lines | Docs lines | Closed | Started at end of day | Expected drift                         |
| ---------- | ------------: | ------------: | ---------: | -----: | --------------------: | -------------------------------------- |
| 2026-10-10 |          1644 |         21138 |        861 |      0 |                    22 | tooling_lead, nothing_closed, over_wip |
| 2026-10-11 |           108 |          7227 |        371 |      0 |                    22 | tooling_lead, nothing_closed, over_wip |
| 2026-10-12 |            67 |           734 |        236 |      2 |                    24 | tooling_lead, over_wip                 |
| 2026-10-13 |           777 |          1592 |        378 |      7 |                    23 | tooling_lead, over_wip                 |

## Scope limit

`over_wip` cannot currently be evaluated: the deployed velocity contract uses
`cap: null`; VUH-2256 owns the missing per-project WIP setting. A worker cap is
not an issue WIP cap. This replay preserves that unknown and does not fabricate
`over_wip`, add a cap override, or implement drift slice 2. The historical started
counts can still be compared with the plan's proposed cap of 6.

## Verification

Focused integration checks: 2 files, 9 tests passed. A real built-in tracker,
origin git history, authenticated HTTP and the CLI prove historical reconstruction
(including a reopened issue), drift output, rejected invalid/authless requests,
unchanged tracker bytes, no persisted round and no wake.

Source landed at `09d8489147a958ff05c088da8aaab4d226335e35`, rebased onto
`4fcf4324b1b2377f74e3e56214a9abd7fd5652a1` (milestone reporting and VUH-2300's
native cwd census fix).

**Full-gate result: incomplete, exit 1; not a green root gate.** The required
`clankie heavy -- pnpm check:landing` checked `3c70da847` against `8dce245f6`.
Skills, format, lint, dead-code, docs, retired claims, evidence and all six selected
package typechecks passed. The run reported 333 parallel test files passing,
then spent an extended period in real integration-runner cases. Its owned process
tree showed repeated old-base `lsof` scans. The lead explicitly authorized stopping
it, recording it as incomplete, rebasing onto the VUH-2300 fix and using focused
delta checks (lead message #8). No test failure was reported before interruption.
The record also has `sourceStable: false`: an untracked evidence README draft was
created during the run; implementation files stayed unchanged. Revalidation
correctly refused the incomplete record. The raw nonzero result is retained.

**Rebased focused passes:** six files, 55 tests passed in 218.44 seconds, covering
historical replay, milestone reporting, provider/runtime delivery, native cwd
observations, cache reclamation, the full integration-runner file and tracker
outcomes. Rebased service, TUI and work-items typechecks passed. Formatting of all
13 touched files and lint of the resolved shared test file passed. The conflict
resolution preserves both milestone-reporting and replay cases. The lead's
explicit focused-check exception authorized this landing; no green full gate is
claimed.

## Deployed replay

The lead reported `ca460ed40` (including replay `09d848914` and VUH-2312's
cadence persistence) healthy at **2026-10-15 21:10:31Z**. The source CLI read the
running service successfully (exit 0; completed 2026-10-15T21:11:01.060745+00:00):

```sh
clankie auto rounds --replay --project kh2-multiplayer \
  --since 2026-10-10T00:00:00-05:00 --until 2026-10-14T00:00:00-05:00
```

| Day        | Product / tooling / docs lines | Closed | Historical started | Actual drift                     |
| ---------- | -----------------------------: | -----: | -----------------: | -------------------------------- |
| 2026-10-10 |             1644 / 21138 / 861 |      0 |                 22 | `tooling_lead`, `nothing_closed` |
| 2026-10-11 |               108 / 7227 / 371 |      0 |                 22 | `tooling_lead`, `nothing_closed` |
| 2026-10-12 |                 67 / 734 / 236 |      2 |                 24 | `tooling_lead`                   |
| 2026-10-13 |               777 / 1592 / 378 |      7 |                 23 | `tooling_lead`                   |

An independent project read confirms Auto is enabled and these declarations are
still saved at revision `b1395efcdc3343331066ca4ca441cdaeb27aae0c8687ff273376edca78c4a1df`:

```json
["inject/", "common/", "server/", "runtime/", "tools/launcher/", "tools/packaging/", "content/"]
```

Every requested day's churn, total closures and started count matches VUH-2255
exactly. On October 13 the seven closures split into five owner-facing and two
unlinked. Each replay uses its day's completed America/Chicago boundary and the
same slice-1 detector as a live tick. The preceding October 9 context is
2280 product / 13001 tooling / 819 docs (the plan has 2282 / 12999 / 819); that
two-line category difference does not change the October 10 tooling predicate.
The raw output retains those actual context numbers.

All four records explicitly have `cap: null`, so none claims `over_wip`. Their
started counts exceed the proposed cap of 6, but that numerical comparison is
not an emitted signal. This is the acceptance gap deferred to VUH-2256.

Normal recorded-round reads immediately before and after replay both returned
`42b5412f-afd8-48b2-8cde-5ef566af6772` at 20:41:38.232Z, confirming replay
records were not appended to the live journal. The integration proof additionally
checks unchanged tracker bytes and zero wakes; the live request is read-only.

## Normal live round

Pending the next natural KH2 Auto round. No forced wake. Per the lead, allow
45 minutes after the healthy deploy, until **21:55:31Z**. VUH-2312 preserves
cadence across deploys. If no new round is recorded by then, use the expressly
authorized 19:38Z record with its age caveat; do not present it as post-deploy.
