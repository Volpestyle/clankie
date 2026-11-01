# ADR 0329: Codex reviews on the owner's Mac, and builds run in local workers

Status: Accepted, 2026-11-01, on James's "Yes, add it" to this plan, and his
word that he turned the cloud Codex review off ("turned it off"). Amends
[ADR 0310](0310-ci-is-a-checkpoint-not-a-wait.md) and the `codex-clean` check
it keeps; builds on [ADR 0203](0203-clankie-keeps-what-better-models-cannot-absorb.md)
(no headless agents) and [ADR 0207](0207-work-records-and-native-agent-delivery.md).

## Context

Every pull request in clankie, clankie-app and clankie-ops was reviewed by the
cloud Codex bot. A builder commented `@codex review`, waited for the bot, and
the `codex-clean` workflow read the bot's summary comment to post a status on
the head commit. Each round went through someone else's queue, findings came
as separate comments, and a reviewer could not run anything on the owner's
own fleet. The owner's Mac already runs Codex and Claude workers through
Clankie, with the owner's `gh` login.

## Decision

- **A Codex worker on the Mac reviews.** It runs as a native Codex pane hired
  through Clankie (no headless reviewer). For each request it prepares a
  read-only worktree of the pull request's exact head under
  `~/dev/.clankie-checks/codex-review/` (never `~/dev/clankie`), reviews the
  diff there, and posts every finding as **one** GitHub review headed
  "Codex review", under the Mac's `gh` login. Findings on diff lines are
  inline; the rest go in the review body. The review carries a
  `codex-review:v1` marker with the commit and the count, so the next round
  can check earlier findings.
- **`codex-clean` is the Mac's status now.** `prepare` sets it to pending on
  the head, and `post` sets it to success when the review has no findings and
  to failure otherwise, on that exact commit. A new push has no status until
  the reviewer reviews it again. The cloud workflow that derived it from the
  bot's comments (`.github/workflows/codex-clean.yml`) is removed, and the
  cloud Codex review is off on all three repos.
- **Merging waits on it.** `scripts/codex-review.mjs land` merges a ready pull
  request only when `codex-clean` passed on its current head and every other
  status and check run there finished green, against that exact head. The
  private repos' plan has no GitHub auto-merge or required checks, so `land` is
  their merge. On clankie, GitHub auto-merge waits on `codex-clean` the same
  way once the owner lists it as a required check in the `main` ruleset; that
  setting is the owner's.
- **Building happens in local workers, led from Duet.** Each task gets one
  Clankie worker on the owner's machines, in its own fresh worktree, with a
  Claude Duet thread (or another connected lead) leading it. The worker plans,
  builds, runs focused checks and opens the pull request as a draft early; the
  pull request on GitHub is the last stop, where CI and the Mac review meet.
  Worker questions go to the lead, never to the owner.

`scripts/codex-review.mjs` (`prepare`, `post`, `status`, `land`) needs only
Node, git and `gh`. The `codex-review` dev skill teaches the reviewer and the
builder their halves.

## Consequences

- A review costs the owner's Codex plan, not a cloud queue, and runs beside
  the rest of the fleet. When the Mac is off, nothing is reviewed and nothing
  merges; that is the intended stop.
- The review and the status are written as the owner. Anyone with the Mac's
  `gh` login can set `codex-clean`, which is the same trust the owner's merge
  already had.
- The repos' agent guides replace `@codex review` with a request to the Mac
  reviewer.
