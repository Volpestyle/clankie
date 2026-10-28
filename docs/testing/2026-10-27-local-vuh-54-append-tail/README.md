# Journal append refuses whole records past a stale base (LOCAL-VUH-54)

Issue: LOCAL-VUH-54

`appendJournal` used to cut every byte past the backend's cached live size as a
torn tail. It now reads those bytes, up to 64 MiB, and refuses with nothing cut
when any line start holds a whole parseable record, framed or unframed. Over
64 MiB is refused unread. Genuinely torn final lines are still cut.

## Proof

- **Stale base, real files, fresh-process reopen.** A copy of a real journal store
  commits the stale writer's own next line. Another process then acknowledges
  `ExternalX`. `appendJournal` is called with the stale size, bypassing the
  LOCAL-VUH-51 generation guard as rejected head `92019d8df` did. Framed,
  unframed (rollback build) and damage-then-record tails are all refused. The
  segment is byte-identical, and a fresh process still opens `ExternalX`. A
  sparse 64 MiB + 1 tail is refused unread, and its size is unchanged.
- **Red on the base.** With the previous `appendJournal`, the same test fails
  with `promise resolved "625854" instead of rejecting`. The append truncated
  `ExternalX` and wrote over it.
- **Torn tails are still repaired.** Four torn final lines each pass the same
  checks: a framed prefix with no newline, a framed line whose newline arrives
  before its stated length, a whole unframed record missing its newline, and a
  torn framed line after two unframed rollback lines. In each case a fresh open
  skips the line and a child-process commit cuts it. Every line parses
  afterwards, the sync id advances by one, and both rollback records survive.
  The existing LOCAL-VUH-47 damage tests are unchanged.
- **Regressions.** The tracker suites pass: 27 files, 100 tests. LOCAL-VUH-51's
  `race.ts` and `stale-base.ts` pass unchanged.
- **Landing gate.** `check:landing` is green: 423 files and 3,095 tests passed,
  16 tests skipped. It exits 3 pending review.

`proof.log` holds the red and green runs, the suites, both flows and the
candidate diff. `landing-gate.log` and `landing-gate.json` are the gate's
output and evidence.

## Gap

An interrupted append of a single record over 64 MiB leaves a tail that every
append refuses until it is recovered by hand, following the work-items README.
How often a single record that large occurs was not measured.
