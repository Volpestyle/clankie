# Review and delivery

How [lead](../SKILL.md) gets an accepted result to its destination.

## Review

Respect the repository's review gate. Where one independent review is required,
give one bounded pass after the producer's checks: inspect the artifact itself
(for code, its scoped diff) and the integration boundary that could break,
without rerunning the producer's suite or becoming a second implementer.

Independence is what makes that pass worth having. Re-reading the producer's
reasoning mostly confirms it, so brief the reviewer from the acceptance and the
artifact, not the producer's transcript, and settle a behavioral question by
running the real thing. Models rate output like their own more favorably: for a
consequential change, prefer a reviewer from another model family when usage
allows.

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

## Landing

Brief workers to land by the workspace's own landing rules (for Clankie's own
repositories, the repository's agent instructions and ADR 0240). Require the
checked HEAD, fixed base, gate exit status and evidence path in the worker's
report, then the pushed SHA; a clean-main zero-test run does not verify an
earlier landing. Where those rules let the lead accept a gate whose only
failures are unchanged timing-sensitive cases, that is a lead acceptance
decision labelled as such, never a green full gate; failures in changed code or
affected consumers still block, and assertions, timeouts and product defaults
are never weakened to pass.

The optional `clankie integrate` queue composes and gates a batch; its batching,
cancel, revert and deploy-hold commands are in
[the CLI reference](../../../../docs/cli.md#integrate). Read the receipt before
claiming delivery: a passing gate is not a confirmed push, and a partial batch
can land core while the app is still pending. Reconcile an uncertain send
through origin first. Never switch a worktree while its gate runs, accept a pass
for another HEAD, gate against live shared state, or force push a rollback. A
deploy hold keeps `clankie update` from replacing the running service for a live
test and never holds `main`; release one that has outlived its purpose, yours or
a worker's, with a recorded reason.

## Work repositories

For a work repo, read its owner overrides for push, release and closure. Keep
work forge credentials in the approved native harness context, outside
Clankie's connected accounts; the forge must protect the default branch and
require MR approval. Use Claude Code or Codex when native approval prompts are
required: Pi has lane grants and no permission prompts, so the owner must
explicitly accept that boundary or choose native-seat operator turns. Workers
and the operator seat keep their harness permissions. Preferences and account
context are not same-user shell isolation. See
[worker access](../../../../docs/worker-access.md#work-repositories). Do not
apply one work project's restrictions to social/play lanes or other repos.

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
