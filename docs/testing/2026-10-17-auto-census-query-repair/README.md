# VUH-2335: Auto census and bounded Linear queue repair

Issue: https://linear.app/vuhlp/issue/VUH-2335
Decision: [ADR 0270 amendment](../../adr/0270-auto-rounds-measure-outcomes-and-name-drift.md).

## Observed faults

The first natural post-deployment round at 06:42Z recorded zero local seats
while the lead reported about nine active Mac hires. The producer used the
roster's display hostname where enrolled roots use the canonical `local`
machine ID. Live settings already enroll the worker worktree roots. A
read-only check also confirmed this worker's exact native seat as a Clankie
hire; adding a separate project-membership scanner was unnecessary. The captured
zero was for `clankie-work`; core has the separate `clankie` project binding.
The capture does not establish nine seats for `clankie-work`: live verification
must identify the exact project rather than infer membership from its name.

The same Auto tick's KH2 queue failed with Linear complexity 35,346 against its
10,000 maximum. The original project page contained fifty issues, each with
bounded nested labels and both blocker directions.

## Repair and regression evidence

Auto projects use canonical local/fleet routing IDs, including named local
routes, and count repeated projections of the same native occupant once per
machine. The prompt, measurement and aggregate totals share the census and
workspace matching. Unknown sources/statuses cannot establish either staffing
signal. The delivery guard reads a fresh census before delivery.

The integration reconstructs nine working Mac seats and three idle/done seats
in enrolled linked worktrees, with a display hostname and a duplicate local
alias. It verifies stored counts of 9 active, 3 idle and 12 occupied, a reached
worker cap, remote Windows matching, path boundaries and unknown observations.
Those census inputs are explicit reconstruction, not a historical host capture.
The existing real-tracker, journal, HTTP/CLI and overnight-capacity replay
remain exercised.

Linear now pages ten project issues at a time and still follows every issue
and overflow relation cursor. The HTTP provider fixture replays the recorded
complexity refusal and proves that later issue pages and later blocker pages
retain unrelated ready work. A real read-only Linear check accepted the same
smaller query across all five pages, yielding fifty unique current KH2 issues
and 35 blocker edges; no labels or relations overflowed in that live read.
This provider check is separate from deployed Auto verification.

Focused staffing, lead-round and velocity checks passed all 43 tests. Restoring
only the old hostname mapping and oversized page size made both corresponding
regressions fail (2 failed, 1 passed); the fixed files were restored byte for
byte. Raw results, current producer diff and live provider receipts are in
`evidence.json`. The issue records the final root gate and landed revision.

## Remaining live proof

Keep VUH-2335 Verifying until the lead deploys the repair and a natural Auto
round records counts consistent with its live fleet, plus a known KH2 queue
when its tracker is readable. Missing PC sources must remain unknown. No
worker deployment, shared-service restart or PC steering was performed.
