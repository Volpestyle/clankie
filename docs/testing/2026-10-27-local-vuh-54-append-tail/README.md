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

[`proof.log`](clankie://evidence/sha256/5856c3c57fcd17b8272724e03f3fed9d3b74c95d1da157ca1167b301a09b2921)
holds the red and green runs, the suites, both flows and the candidate diff.
[`landing-gate.log`](clankie://evidence/sha256/c02a6e9610c521673c087d4021545192e164dd63985c15a7b837517972b8c423)
and
[`landing-gate.json`](clankie://evidence/sha256/1a0e3cf661e59eb470e393e92fd283bbcb0364aae789f654e3d5eb9b120f6126)
are the gate's output and evidence. That gate run exited 3 pending review; the
rerun after approval on the same head exited 0.

## Review follow-up

The fix landed as `96e4fa200` after the reviewer approved it. The follow-up acts
on that review's notes:

- Both refusals now run before `beforeAppend` and dispatch, so the caller sees
  a definite no-effect refusal instead of an uncertain dispatch. A re-stat
  after dispatch refuses if the size moved. The stale-base test asserts that
  dispatch never ran. On the `96e4fa200` order it fails with
  `framed: expected true to be false`.
- The oversized tail is now only zeros past the stale size. With the limit
  removed, it fails with `promise resolved "625854" instead of rejecting`, so it
  proves "refused unread" on its own.
- The work-items README says that a failed fsync plus a failed self-cut leaves
  a whole line. The process then needs a restart.

[`followup.log`](clankie://evidence/sha256/f724477b326453ebf64576114f49ee5a6b801d921f8ffb26b81303621ea98703) holds the follow-up's green run, both red runs and its diff.

## Gap

An interrupted append of a single record over 64 MiB leaves a tail that every
append refuses until it is recovered by hand, following the work-items README.
How often a single record that large occurs was not measured.
