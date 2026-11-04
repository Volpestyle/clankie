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
allows ([ADR 0208](../../../../docs/adr/0208-agents-carry-a-role-the-world-reads-it.md)).

For projects that want independent review of every landing, set a standing
reviewer instead of relaying packets by hand
([ADR 0287](../../../../docs/adr/0287-a-standing-reviewer-gates-every-landing.md)):
hire a reviewer seat, ideally from a different harness or model family than the
authors, and run `clankie project settings PROJECT --reviewer-role reviewer`.
Authors then `submit_for_review` and the reviewer decides with `review_verdict`;
the service routes the patch and `clankie review status` holds until the
reviewer approves that exact patch. A verdict notice to you asks for no action.
Keep a reviewer seat live while the setting is on, or landings wait. `waive_review`
lands one exact patch without review. It is rare, needs a reason, and is recorded
with you as the waiver and shown to the owner; never use it to skip pushback you
disagree with. Look at the candidate with `clankie review list|show`.

Ask for coverage of the changed boundary in this order: full E2E with real
dependencies and nothing mocked, integration across data, API and schema
boundaries, then goldens grounded in real examples. Push back on new unit-test
bloat; pruning existing tests is a separate reviewed effort
([ADR 0221](../../../../docs/adr/0221-tests-prove-the-product-and-its-boundaries.md)).

When correctness depends on interpreting observations (pixels, audio, sensor
readings, extracted labels), pair the first producer change with a small
inspected source sample and valid controls before scaling up. Passing synthetic
tests prove code behaviour, not the measurement.

Reuse valid proof for unchanged inputs: a rebase, ticket split or doc edit alone
does not justify another build, suite or recording. A real failure needs
investigation. Waived or deferred verification stays labelled and is never a
pass. When the user authorizes partial closure, close the accepted slice and
keep what is missing in a focused follow-up (owner preference).

## Landing

Brief workers to land by the workspace's own landing rules (for Clankie's own
repositories, the repository's agent instructions). Require the checked HEAD,
check results and evidence path in the worker's report, then the pull request
or pushed SHA; a clean-main zero-test run does not verify an earlier landing.
Failures in changed code or affected consumers block, and assertions, timeouts
and product defaults are never weakened to pass.

In Clankie's own repositories every change lands through a pull request, one
worker per task, never two on the same files. A ready pull request merges once
the worker's local checks pass on its final rebased head (the tests for what it
changed, typecheck, oxlint, oxfmt, deadcode and doc links, through
`clankie heavy --`) and the quick checks (`check`, and `build` where it runs)
are green. The real-app and simulator runs never run per pull request: they run
on `main` after merges and nightly, never gate, and a red one files a
`ci-finding` issue. A change to a security or trust check (admission, auth, read
boundaries) comes back to you with its head, and you have it reviewed
independently before it merges
([ADR 0332](../../../../docs/adr/0332-clankies-own-pull-requests-merge-on-green-checks.md),
[ADR 0347](../../../../docs/adr/0347-a-pull-request-merges-on-local-checks-and-the-quick-checks.md)).
The worker rebases onto `origin/main` once, right before it merges, never by
merging `main` in over and over, pushes with `--force-with-lease` to its own
branch only, and flags a rebase conflict in files it didn't touch instead of
resolving another worker's code. There is no landing queue: not GitHub's merge
queue
([ADR 0345](../../../../docs/adr/0345-a-pull-request-rebases-onto-main-once-before-it-merges.md)).

A deploy hold (`clankie update holds|hold|release`) keeps `clankie update` from
replacing the running service for a live test and never holds `main`; release
one that has outlived its purpose, yours or a worker's, with a recorded reason
([ADR 0240](../../../../docs/adr/0240-changes-land-directly-on-main.md)).

## Offer a faster project CI setup

When taking on a repository, read its workflow definitions and recent run logs
before calling its CI slow. Notice full suites on every draft push, superseded
runs that keep running, cold dependency/compiler caches, and failures shared
with the base that hold unrelated work. No run history means unknown, not slow.

Offer the owner a concrete fast-CI starter as a draft pull request: quick checks
on draft pushes, full checks on the final ready head, cancellation of superseded
runs, caches seeded from the default branch, and a strict base comparison for
existing failures. New failures, missing/incomplete results and infrastructure
errors still fail; no tests or assertions are removed or weakened. The owner
chooses the commands, runner, test/report format and whether to adopt it.

A project assignment, a slow run or Clankie's own landing doctrine never grants
permission to rewrite another repository's CI. Show the proposed files and
tradeoffs first. After the owner chooses the offer, use the normal project
worker and forge path to open its draft PR. Their review, branch protection and
merge choices remain theirs. Record the offer and decision on the existing work
item; an unanswered offer changes nothing.

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
([ADR 0181](../../../../docs/adr/0181-clankie-is-independent-of-his-connections.md),
[ADR 0239](../../../../docs/adr/0239-worker-harnesses-sign-in-with-their-own-logins.md)).

## Ownership while delivering

Use the existing task and claim tooling for ownership, and the real scheduler
or lease for shared editors and capture. Do not invent a parallel registry; a
remembered paragraph is not a lock. Repair a demonstrated gap in the tool
instead of adding warnings (owner preference).

Keep one owned worktree per deliverable; its native slices and reviews share it
under distinct paths ([ADR 0223](../../../../docs/adr/0223-hires-use-repo-workspaces-and-pipeline-tabs.md)). After landing, keep needed reports and evidence, verify
the branch is merged at the requested destination and the tree is clean, then
remove it ([tidying](fleet-tools.md#closing-panes-and-tidying-worktrees)).

After a bounded delivery, look at where it actually waited, repeated work or lost
ownership, and fix that before widening the setup. The user judges the result;
they should never have to relay messages between workers.

Native subagents of one seat share that seat's scratchpad directory. Give each
brief its own scratch subdirectory (for example `scratchpad/<deliverable>/`) and
owned output paths, so one child's helper scripts or captures never overwrite
another's (owner preference).
