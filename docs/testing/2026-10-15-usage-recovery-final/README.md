# VUH-2310 final verification

Tracks: https://linear.app/vuhlp/issue/VUH-2310

Verified source: `3d388483384cb20811b1febf9e84523448463a20`, based on
`da8ce5b47f7e9a2c72e4e6f3c88740a56a388970`. The following evidence commit
adds only this record and its manifest; source and test inputs are unchanged.

## Focused landing gate

The assigned lead explicitly replaced further full-gate restarts with focused
checks after concurrent main changes: Auto velocity, protocol, settings,
consumer typechecks and VUH-2310's tests. These passed on the rebased tree:

- Seven test files: **65 passed**, exit 0. Includes worker accounts/reset recovery,
  Auto velocity, runtime-provider delivery, product paths, protocol contracts,
  project settings and the TUI project menu.
- Typechecks: **4 successful**, exit 0, for `@clankie/clankie`,
  `@clankie/protocol`, `@clankie/settings` and `@clankie/tui`.
- Reset capture: one recovery with 2% used and its reset/observation timestamps;
  Auto shows 98% left; repeat recovery count is zero.

## Full-gate result

**Not green.** The completed default gate failed the existing
[VUH-2299 membership timeout](https://linear.app/vuhlp/issue/VUH-2299).
Its bailed run also emitted an OpenCode fixture disconnection rejection.
A later non-bailing run passed all five selected package typechecks and 274
files, including all 21 OpenCode lifecycle tests, before it was stopped when
main advanced. It emitted failure diagnostics for VUH-2306's ten-landings case.
The lead then explicitly authorized the focused gate and known-flake exception.
These interrupted runs are retained as interrupted, not passing full gates.

The first attempt also caught `TS2379` in the new missing-usage test fixture;
that fixture was corrected before the successful final typechecks.

## Isolated passes and main comparisons

Unchanged main `35551ada4` and the corresponding VUH-2310 tree each ran both
complete membership/OpenCode files: **71 passed, one failed**, with the same
VUH-2299 `unknown` / `timeout` instead of `member`. OpenCode passed 21/21 on
both trees without unhandled errors; no separate OpenCode defect reproduced.

On unchanged `35551ada4`, the exact
[VUH-2300 reclaim case](https://linear.app/vuhlp/issue/VUH-2300) timed out
(120s test plus 30s afterEach and 30s aroundEach teardown), and
[VUH-2306's ten-landings case](https://linear.app/vuhlp/issue/VUH-2306)
timed out at 120s. These are failed main comparisons, not isolated passes.
Raw logs, gate records, observation load samples and the final focused outputs
are combined in `verification.log` in the evidence store.

No vendor account reset was forced and no installed service was restarted.
The assigned lead owns closure and deployment after the push.
