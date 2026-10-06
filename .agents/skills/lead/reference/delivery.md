# Review and delivery

How [lead](../SKILL.md) gets an accepted result to its destination.

## Review

Respect the repository's review gate. Where one independent review is required,
give one bounded pass after the producer's checks: inspect the artifact itself
(for code, its scoped diff) and the integration boundary that could break,
without rerunning the producer's suite or becoming a second implementer.

Ask for coverage of the changed boundary in this order: full E2E with real
dependencies and nothing mocked, integration across data, API and schema
boundaries, then goldens grounded in real examples. Push back on new unit-test
bloat; pruning existing tests is a separate reviewed effort.

When correctness depends on interpreting observations (pixels, audio, sensor
readings, extracted labels), pair the first producer change with a small
inspected source sample and valid controls before scaling up. Passing synthetic
tests prove code behaviour, not the measurement.

Reuse valid proof for unchanged inputs: a rebase, ticket split or doc edit alone
does not justify another build, suite or recording. A real failure needs
investigation. Waived or deferred verification stays labelled and is never a
pass. When the user authorizes partial closure, close the accepted slice and
keep what is missing in a focused follow-up.

## Landing Clankie's own changes

In Clankie's source-checkout service, hand approved commits to
`clankie integrate` in order (repeat `--app SHA` for the app), with `--push` for
an authorized landing. It composes fresh origin in independent worktrees,
installs real packages, runs isolated full gates and keeps the tested HEAD and
exit evidence. Read the batch record before claiming delivery: a passing gate is
not a confirmed push, and a partial batch can land core while the app is still
pending. Retry after a definite app rejection skips landed core; reconcile an
uncertain send through origin first. Never switch a worktree while its gate
runs, accept a pass for another HEAD, gate against live shared state, or force
push a rollback: `integrate revert PASSED_BATCH_UUID` restores a known good tree
with a new gated commit.

Protect live tests with `integrate hold --holder NAME --reason TEXT --pane ID`
(or `--seat ID`). Holds never expire and appear in `integrate holds` even when
the holder is gone. Push and runtime-update admission refuse a named hold; an
owner override names each one with `--override-hold UUID --actor NAME --reason
TEXT`. Release a finished hold explicitly with actor and reason.

## Ownership while delivering

Use the existing task and claim tooling for ownership, and the real scheduler
or lease for shared editors and capture. Do not invent a parallel registry; a
remembered paragraph is not a lock. Repair a demonstrated gap in the tool
instead of adding warnings.

Keep one owned worktree per deliverable; its native slices and reviews share it
under distinct paths. After landing, keep needed reports and evidence, verify
the branch is merged at the requested destination and the tree is clean, then
remove it ([tidying](fleet-tools.md#closing-panes-and-tidying-worktrees)).

After a bounded delivery, look at where it actually waited, repeated work or lost
ownership, and fix that before widening the setup. The user judges the result;
they should never have to relay messages between workers.
