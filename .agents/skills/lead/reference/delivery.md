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

Everyone, including James's interactive panes and their subagents, lands
clankie and clankie-app directly on `main` (ADR 0240). Brief workers to stage
only their files, commit, and `git pull --rebase origin main`. Before pushing,
require the repository-root `clankie heavy -- pnpm check:landing`, using its own
`--changed` test selection against fetched `origin/main`. Focused checks are for
iteration; a hand-picked subset is not the landing gate. A source change after
the gate requires another root gate. After a base-only move, the worker rebases
and runs `pnpm check:landing --revalidate`; exit 0 keeps the green gate, exit 1
names the overlapping incoming paths and requires another root gate. Require the checked HEAD, fixed base,
exit status and evidence path in the worker's report; a clean-main zero-test run
does not verify an earlier landing. Then `git push origin main`, reporting the SHA.
If the root gate's only failures are unchanged timing-sensitive cases outside
the change and its affected imports, the lead may accept the landing after
every exact failing case passes in isolation on unchanged test/product inputs.
Retain the gate's real nonzero exit, exact errors, load samples and isolated
results, labelled **Full-gate result** and **Isolated passes**. This is a lead
acceptance decision, not a green full gate. Failures in changed code or affected
consumers still block; do not weaken assertions, timeouts or product defaults.

The full `pnpm check` runs for releases and on request. The running service
automatically syncs registered local owner checkouts when main advances,
including direct pushes; blocked edits are preserved and reported.
`clankie checkouts sync` is the immediate/manual recovery route.

`clankie integrate` remains optional for a composed, gated batch. The service composes fresh origin in independent worktrees. Compatible requests
waiting during a gate join the next batch, with one root landing gate for the composed
core/app pair. Conflicting requests roll back as a whole; failed shared gates
split into smaller batches until the failing request is reported. Each receipt
keeps its original input, shared batch ID and attempted evidence. Restores and
gate-only requests keep their separate intent. A mistaken request that is still
waiting, yours or a worker's, is withdrawn with `integrate cancel UUID --actor
NAME --reason TEXT`. The receipt keeps who and why; a request already gating
runs on.

Read the receipt before claiming delivery: a passing gate is not a confirmed
push, and a partial batch can land core while the app is still pending. Retry
after a definite app rejection skips landed core; reconcile an uncertain send
through origin first. Never switch a worktree while its gate runs, accept a pass
for another HEAD, gate against live shared state, or force push a rollback:
`integrate revert PASSED_BATCH_UUID` restores a known good tree with a new gated
commit. Integration clones disable client hooks; the live checkout guard does
not affect their attested landing.

A deploy hold keeps `clankie update` from replacing the running service, for a
live test against it: `integrate hold --holder NAME --reason TEXT --minutes N
--pane ID` (or `--seat ID`), at most 60 minutes. It lifts on its own at expiry
with a receipt naming the holder. It never holds `main`: pushes and integrate
landings go ahead, and a gate main moved under keeps its result through
`check:landing --revalidate`. Fleet status, your round and `update` refusals show
each hold's holder, age and time left. Release a hold that has outlived its
purpose, yours or a worker's, with `integrate release UUID --actor NAME --reason
TEXT`; the receipt records who held it, who released it and why. The owner can
instead override a hold for one update with `update --override-holds --reason
TEXT`.

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
