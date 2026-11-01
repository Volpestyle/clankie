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

Work never waits on CI. A quick gate stands in front of `main`, and CI
checkpoints the rest on the side.

- **Iterate in a draft.** A draft pull request gets the quick `check` job on
  every push (format, lint, MCP contracts, fleet fixtures; about a minute).
  Marking it ready for review runs the pull request's gate, and every push after
  that runs it again. A draft cannot merge, so the jobs it skips pass nothing. A
  newer push still cancels the older run.
- **A pull request's gate takes minutes.** It is the landing gate's checks with
  the warm typecheck and only the test files the change itself adds or edits
  (`check-landing.mjs --own-tests`), beside the real-app run on the Mac
  (ADR 0309). `landing` and `mac` stay required; `mac` is skipped on a pull
  request, which passes. `codex-clean`, the Mac's Codex review, is advisory
  since ADR 0331.
- **The rest checkpoints on `main`.** After a merge, the `checkpoint` job runs
  the tests the merge reaches through its imports on Linux, and the `mac` job
  runs them on the Mac. A red run there is a bug to file at the front of the
  queue, not a gate. A newer push to `main` cancels an older run; the nightly
  run covers whatever that skipped.
- **Main's failures are main's.** The landing gate runs every selected test
  instead of stopping at the first failure. When tests fail, CI reruns the
  failed files on the base commit in a scratch worktree, on the same runner. A
  failure the base shares is a warning on the run and does not fail the change;
  a failure the base does not have, a test file the base does not have, a
  file that failed outside any test, or a run with an unhandled error still
  fails it. Nothing is skipped or quarantined. The lead files each shared
  failure as an issue at the front of the queue.
- **Main gets the whole suite nightly.** A pull request runs only the test
  files it edits and the checkpoint the tests its merge reaches, so the `Nightly` workflow runs every test on `main` once
  a night, release-only tests included, and names each failure in its summary.
  A red night is a bug to file at the front of the queue, not a gate.
- **The typecheck starts warm.** The typecheck keeps each program's compiler
  state (`.local/tsbuildinfo`), so a later check rechecks only what changed.
  CI caches it per pull request, seeded from every push to `main`.

An opt-in pre-push hook (`pnpm hooks:install`) formats and lints only the
files a branch changed before each push, so a typo doesn't cost a CI round. It
runs neither the typecheck nor the tests, which stay in their one place.

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

- An iteration push costs about a minute of hosted time and no Mac time. A
  ready pull request costs a few minutes: before this cut it waited up to 15
  minutes for a Mac runner behind other changes' Mac tests, then ran its own
  for up to 15 more, while a change to a core module ran a long test selection
  through its imports on Linux.
- A change can merge with a test it breaks through its imports. The checkpoint
  on `main` names it after the merge and the lead files it first in the queue;
  that is the trade James chose ("lets not gate ourselves by failing tests").
- `main` can hold a failing test without blocking others, so it must be filed
  and fixed, not left; the run's warnings name it.
- GitHub's merge queue is not offered for repositories owned by a personal
  account, so readiness is the draft state rather than a queue.
- The Mac has three runner instances for this repository; a pull request
  takes one, for its real-app run.
- Amends [ADR 0240](0240-changes-land-directly-on-main.md) for pull requests:
  the gate is the same; when it runs is new.
