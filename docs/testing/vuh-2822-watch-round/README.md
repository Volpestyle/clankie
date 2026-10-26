# VUH-2822: working watch observations join the round once

The production `herdr_watch` tool → native runner → `HerdrWatchStore` →
conversation report round → captain wake → native seat outbox path now batches
an uncorrelated working observation and retains its watch. The durable working
notice marker survives a captain restart and re-arming. It never claims the
requested native message completed. A blocked state overtakes a pending round
and reaches the lead immediately through the same path; clean completion keeps
its existing round delivery.

## Proof boundary

`apps/clankie/test/fleet-lead-round.integration.test.ts` exercises the real
production components above, with a synthetic native Herdr transport. The failure case also uses the real Claude hook log and adapter. No Herdr
process or live pane is started or accessed. The fixture explicitly asserts an
empty workspace census (zero restored workspaces). Vitest's existing setup
provides private scratch HOME, XDG config/state/data/cache, credentials and
session stores; the new case asserts scratch HOME/XDG too. This is a service
integration proof, not a live harness or installed-runtime deployment test.

The retained watcher also subscribes to native state changes between polls;
it rechecks native completion at most five seconds later if status stays
working. Failed native Stops remain escalations even if the pane says working.
Gone panes, questions, errors and clean completions retain their existing
routing. No captain restart or context-telemetry source was changed.

## Checks

Run all checks through `clankie heavy --`:

- `pnpm exec vitest run apps/clankie/test/fleet-lead-round.integration.test.ts -t 'uncorrelated working watch|escalation overtakes|holds a clean completion'`
  → 3 passed. The first test spans the real five-second recheck, another round
  deadline, re-arming and captain restart, then requires the changed blocked
  state within two seconds. A separate test requires a blocker within two
  seconds while a ten-second round is still pending.
- `pnpm exec vitest run apps/clankie/test/herdr-watch.test.ts apps/clankie/test/claude-watch-takeover.integration.test.ts apps/clankie/test/fleet-lead-round.integration.test.ts`
  → 100 passed; output retained in `regression.log`.
- `before.log` runs the same three focused cases against the fetched base's
  unchanged `herdr-watch.ts`, restoring the candidate source afterward.
- The exact committed patch additionally requires `pnpm check:landing` and an
  independent APPROVE before push. Their results belong in the issue update;
  this record alone does not claim landing or approval.

## Transcript baseline and remaining measurement

`baseline.json` and `baseline-method.py` record a read-only scan of the two native
lead Claude sessions, deduplicating main-thread user messages by UUID and
excluding tool-result blocks and sidechains. For UTC 2026-10-18 through 10-25,
this narrower observable set has 216 watch notices, 74 working settles (34.3%).
The partial UTC 10-26 count at capture is 33 notices, one working settle.
These count received notices, not necessarily independent model wakes. The
issue's earlier audit reports 368 notices / 115 working settles; these figures
use different inclusion rules and must not be silently substituted for it.
No private message text is published.

A full-day post-deployment transcript measurement is still pending. This patch
has not restarted or changed the installed runtime; fixture results cannot
establish watch wakes per day after deployment. Re-run the retained method over
complete post-deployment days and compare the same inclusion rules. The lead
owns that follow-up and issue closure.

Raw logs, baseline and scan method: [proof bundle](clankie://evidence/sha256/aefd7cb9b8660f0a8663fa7ed7e50c3978efb8f98708ca74452bb564bebc72c0).

## Native failure while the pane still says working

The final revision rechecks native events every five seconds while waiting for
the same report round, preserving its original deadline. A real Claude
`SeatHookLog` and `createClaudeWorkerSeatAdapter` fixture records an uncorrelated
Stop, then a `StopFailure` without changing Herdr's working status. The failure
must reach the captain's outbox before the ten-second round expires. This
avoids treating a stale terminal status as authority over a native failure.

The final focused selector adds `|native failure overtakes` to the command above:
4 cases pass. The native-failure case also runs against preceding patch
`83ac7c749`, demonstrating why the extra recheck is needed. The initial required
landing gate failed its swallowed-rejections phase; the revised wait logs
unexpected observation failures and uses the ordinary retry backoff. The next
gate was deliberately stopped after this further source change, and neither run
is represented as a passing gate.

Final revision: all 101 neighboring watch/round tests pass. The native-failure
case fails on preceding patch `83ac7c749` and passes with the recheck.
[Final proof and first gate failure](clankie://evidence/sha256/8045e0a5c5a70351dc75495c270efa7703f912dc85981bb0522c7d67647e86fb).
