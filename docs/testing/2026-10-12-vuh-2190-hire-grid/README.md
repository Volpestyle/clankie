# VUH-2190: hires after closing a grid pane

The operator's failure was specific to a compacted grid, consistent with the
Work lead's successful hires at 21:03Z and 21:21Z. Closing either left corner
leaves a shape outside the allocator's original row-major split sequence.
The allocator now starts the next numbered grid for that shape, preserving
surviving workers. Normal compatible grids still fill their remaining slots.

The project dispatch fence precedes layout allocation. A host-only allocator
error now proves that no creation command was issued and releases that local
project reservation. Creation/move/metadata uncertainty still retains the
original receipt and allocation. A created first workspace also stays uncertain.
This does not retroactively settle old `start_unconfirmed` records (VUH-2180).

## Real boundary evidence

[proof.json](proof.json) records the installed Herdr CLI/socket journey:

- Close each of the four corners of a real 2×2; allocate twice afterward.
  Both allocations succeed and surviving terminal/tab identities remain intact.
- Refuse a real unmarked foreign tab twice from the same directory, across
  controller recreation, with a project cap of one. Both allocations are
  definitively not started and released; no pane is allocated.
- Lose successful creation/move/metadata replies: they remain uncertain and
  retries do not create a duplicate pane.
- Separate manual proof at 21:26Z: close the top-left pane, then use the
  production allocator and native Herdr startup to start two installed Codex
  0.162.1 TUIs. Both report `interactive_ready: true` and live native processes,
  in the next grid. No model turns or briefs were submitted. This proves grid
  placement/startup, not durable session adoption or brief delivery; Codex's
  no-brief hire path requires a first turn to report its session.

All proof sessions and their owned processes were stopped afterward. Existing
fleet panes and the owner checkout were untouched. Native proof ran in a fresh
isolated Herdr namespace using the existing worker profile; code changes are
in a fresh worktree from fetched main.

## Checks

67 focused checks passed across the real Herdr journey, project hires and fleet
resource hire integration. Explicit touched-file formatting and lint passed.
The integration batch supplies the exact-tree repository landing gate.

Initial scratch attempts used the no-brief controller path, which stopped on a
hook review prompt and then on its missing durable session. Clankie authorized
continuing without trusting for disposable proof only. No hook was trusted or
refreshed. The final native startup proof uses the current worker profile and
needed no hook review. The hook observation is reported separately to Clankie.
