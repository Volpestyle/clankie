# ADR 0347: A pull request merges on local checks and the quick checks

Status: Accepted, 2026-11-03, on the owner's decisions relayed by the lead: "i
wanna always be running app tests (in sim) and ci pipeline as we're merging
work in, but i never wanna gate on it, just keep working, do sensible tests in
the moment, but if we kick off sim integration test every change we're gunna
spend more time testing than building", and "we should always just be keeping
a queue of fixes highlighted by ci and bugs found in sim while also building
out features/working on our other queues of work like github issues or linear
tickets". Amends [ADR 0332](0332-clankies-own-pull-requests-merge-on-green-checks.md)
(its merge gate), [ADR 0310](0310-ci-is-a-checkpoint-not-a-wait.md) and
[ADR 0309](0309-the-real-app-runs-on-every-change.md) (the real-app run moves to
`main`). [ADR 0345](0345-a-pull-request-rebases-onto-main-once-before-it-merges.md)'s
rebase rule stays as is.

## Context

ADR 0332 made a ready pull request merge once `check` and `real-run` were green
on its head, and every ready pull request ran the real app on the owner's Mac
runners. On 2026-11-02 and 2026-11-03 three of those runners failed every job
at "Set up runner", before any of the change's code ran, so green pull requests
waited on re-runs until a job happened to land on a working runner. Even with
healthy runners, a full real-app or simulator run per change spends more time
testing than building.

## Decision

These are the Clankie project's own settings for its repositories (clankie,
clankie-app and clankie-ops). They are not a product rule.

- **A worker tests what it changed, in the moment.** It runs the sensible,
  scoped checks for its change through `clankie heavy --`: the tests for what
  it changed, the typecheck, `pnpm lint` (oxlint `--deny-warnings`),
  `pnpm fmt:check` (oxfmt), `pnpm deadcode` and the doc links
  (`node scripts/check-doc-links.mjs`), and a local real-app or simulator run
  when the change is in how the app starts or behaves.
- **A pull request merges on those plus the quick checks.** A ready pull
  request merges, with a plain merge, once the worker's checks pass on its
  final rebased head and the quick pull request checks (`check`, and `build`
  where a repository has it) are green. The pull request body says which local
  checks ran.
- **Full runs happen in the background and never gate.** The real-app run and
  any simulator or on-device integration job do not run per pull request, not
  per push and not on ready. They run on `main` after merges, coalesced so a
  burst of merges runs once on the newest tip, and on a cadence such as nightly.
  The post-merge jobs and the nightly suite stay as ADR 0310 set them. Suites
  that need the Mac (the native host-receipt suites, which skip on Linux) also
  run nightly on the Mac runner with their gates set, and a skip there fails
  the job (2026-11-03, #647).
- **A red background run is a `ci-finding`, not a stop.** A failure in a run on
  `main` or a scheduled run becomes a GitHub issue labelled `ci-finding` that
  links the failing run. A workflow files it, one issue per failing test or
  job, and a repeat failure comments on the open issue instead of filing a new
  one. A self-hosted job that dies before its checkout, as a broken runner does
  at "Set up runner", can't file its own; a hosted follow-up job files it, as one
  finding per broken runner, naming it (#551). The lead ranks each by how badly
  it blocks current goals.
- **Two queues, worked in parallel.** A lead keeps some workers on the
  `ci-finding` queue alongside workers on the regular issue queue, so neither
  starves the other. It sizes the split to the queues, with at least one worker
  on `ci-finding` issues while any are open.
- **A trust check gets an independent review first.** A change to a security
  or trust check (admission, authentication, read boundaries and the like)
  reports its head to the lead, who has it reviewed independently before it
  merges. Every other change merges with no review gate, as in ADR 0332.

## Consequences

- A pull request no longer waits on the Mac runners, and no pull request runs
  the real app; `pr-state`, which only decided whether a pull request was ready
  for it, is gone.
- A regression only the real app or a simulator shows can reach `main`. The
  background run catches it, and its `ci-finding` issue is how it gets fixed.
- A job that fails before its own steps run (such as a runner that cannot set
  up) files nothing itself; the red run on `main` is still visible.
- No GitHub branch protection or ruleset requires a check on `main` (read on
  2026-11-03), so no repository setting changes.
- The repo guide (`AGENTS.md`, linked as `CLAUDE.md`), the lead skill, the
  `verify-clankie` and `codex-review` skills, the quality gates guide, the
  architecture overview and the retired-claims registry state the new rule.

## Evidence and limits

This record links no measurement. The decision cites three Mac runners that failed every
job at "Set up runner" on 2026-11-02 and 2026-11-03, and the owner's judgment
that a real-app or simulator run per change spends more time testing than
building. No branch protection or ruleset required a check on `main` when read
on 2026-11-03.

## Revisit when

- Background runs on `main` stop reporting because the Mac runners keep failing
  before any code runs.
- Regressions that only the real app or a simulator catches reach `main` faster
  than their `ci-finding` issues close.
- A branch protection rule or ruleset on `main` starts requiring a check.
