# ADR 0310: CI is a checkpoint, not a wait

Status: Accepted, 2026-10-31, on James's word: "we should be constantly
pushing, iterating, restarting, finding bugs, and adding those tickets to front
of queue based on severity for enabling our current goals, but we have the ci
running on the side, just checkpointing really, and fixing things constantly in
the background, but it shouldn't slow us down", "its part of enabling a fast
sdlc", and "lets not gate ourselves by failing tests".

## Context

Every push to a pull request ran the whole landing gate on a hosted runner
(about 20 minutes, a typecheck from cold every time) and queued a job on the
owner's Mac, which took one job at a time. Agents iterate in many small pushes,
so most runs checked a commit that was replaced minutes later, and the Mac
queue grew behind them. A test that already failed on `main`
(fixture-admission-corrective on hosted Linux) then failed every unrelated pull
request until someone fixed it, holding three of them for an afternoon.

## Decision

Work never waits on CI. CI checkpoints the work on the side and keeps the
full gate in front of `main`.

- **Iterate in a draft.** A draft pull request gets the quick `check` job on
  every push (format, lint, MCP contracts, fleet fixtures; about a minute).
  Marking it ready for review runs the landing gate and the Mac job, and every
  push after that runs them again. A draft cannot merge, so the jobs it skips
  pass nothing. A newer push still cancels the older run.
- **The full gate is unchanged in front of `main`.** `landing`, `mac` and
  `codex-clean` stay required, and a ready pull request runs all of them on its
  exact head.
- **Main's failures are main's.** The landing gate runs every selected test
  instead of stopping at the first failure. When tests fail, CI reruns the
  failed files on the base commit in a scratch worktree, on the same runner. A
  failure the base shares is a warning on the run and does not fail the change;
  a failure the base does not have, a test file the base does not have, a
  file that failed outside any test, or a run with an unhandled error still
  fails it. Nothing is skipped or quarantined. The lead files each shared
  failure as an issue at the front of the queue.
- **The Mac runs only when it has tests to run.** A free Linux job works out
  the Mac job's changed-test selection first; when it selects nothing, the Mac
  job is skipped and passes. If that job fails, the Mac job runs anyway.
- **The typecheck starts warm.** The typecheck keeps each program's compiler
  state (`.local/tsbuildinfo`), so a later check rechecks only what changed.
  CI caches it per pull request, seeded from every push to `main`.

For leads and workers: push often and keep working while CI runs; nobody waits
idle on a run. Open pull requests as drafts and mark one ready when its work is
done, so the full checks run once before merge. Run them in one place, never
twice: CI for a pull request, the local landing gate for a direct landing on
`main` (ADR 0240). While iterating, a worker runs only the tests for what it
changed. CI does not skip a check because a worker already ran it: a required
check is proven on CI's own checkout of the exact head, and the warm typecheck
is the reuse that is safe. A red check is a bug to file
and order by how badly it blocks the current goals, not a reason to stop.

## Part of Clankie core

This is a core feature of how Clankie works, not a habit of this repository
(James: "All projects", "this can be part of clankie core, as to just improve
user experience of clankie"). The doctrine ships in the core `lead` skill, so
Clankie works this way on any project he leads. Any assistant leading through
Clankie gets it too (James: "and any assistant acting as a lead in clankie"):
the connector's server instructions state the rule and point to the `lead`
topic of `clankie_guide`, which serves that same skill. The
CI mechanics above are this repository's own; core will also offer a project a
fast-CI starter when it takes one on: quick checks on drafts, the full gate on
ready, cancel on push, warm dependency and compiler caches, and the base
comparison for test failures. Building that offer is a follow-up.

## Consequences

- An iteration push costs about a minute of hosted time and no Mac time. The
  full gate runs when a pull request is ready, and once more for each fix after
  that.
- `main` can hold a failing test without blocking others, so it must be filed
  and fixed, not left; the run's warnings name it.
- GitHub's merge queue is not offered for repositories owned by a personal
  account, so readiness is the draft state rather than a queue.
- The Mac still takes one job at a time for this repository; more runner
  instances there are a separate step.
- Amends [ADR 0240](0240-changes-land-directly-on-main.md) for pull requests:
  the gate is the same; when it runs is new.
