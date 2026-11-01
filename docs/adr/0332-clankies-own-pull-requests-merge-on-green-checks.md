# ADR 0332: Clankie's own pull requests merge on green checks

Status: Accepted, 2026-11-01, on James's word that the lead may set up
Clankie's own review pipeline however it wants ("you can set up the review
pipeline however you want", "just for our sdlc of clankie this is how im doing
it"), and his yes to merges waiting only on the fast checks. Supersedes the
review gate and the merge rule of
[ADR 0329](0329-codex-reviews-on-the-owners-mac.md); its local-worker building
stays. Amends [ADR 0310](0310-ci-is-a-checkpoint-not-a-wait.md).

## Context

ADR 0329 made a Codex worker on the owner's Mac review every pull request in
clankie, clankie-app and clankie-ops, and made merging wait on its
`codex-clean` status. When no Mac reviewer could be hired, green pull requests
sat for hours with nothing left to do. The landing gate, about ten minutes on
Linux, also ran before every merge. The owner then left the choice of review
pipeline for Clankie's own development to the lead.

## Decision

These are the Clankie project's own settings for its three repositories. They
are one project's choice, not a Clankie rule.

- **A pull request merges once its fast checks are green.** In all three repos,
  a ready pull request merges, with a plain merge, once `check` and `real-run`
  passed on its head and it has no conflicts with `main`. Nothing else gates
  it, and nobody waits on a reviewer.
- **The landing gate checkpoints on `main`.** The `landing` job runs on each
  push to `main`, after the merge, beside `checkpoint` and `mac`. A red run
  there is a bug to file at the front of the queue, never a gate.
- **Local review is advisory.** A review by Codex on the Mac, OpenCode 2, Kimi,
  MiMo or any other model may run before or after a merge when one is free. Its
  findings are filed as follow-up issues at the front of the queue, by how
  badly they block the current goals, and fixed in their own pull requests.
  `codex-clean` stays an informational status; no merge waits on it, and
  `scripts/codex-review.mjs land` is optional.
- **The lead picks the reviewer, or none.** The lead may also land a change
  straight on `main` through `pnpm check:landing` (ADR 0240) with no review.

## Not a product rule

How much review gates a merge is each project's choice, and the owner's.
Another project, such as one of the owner's work repositories, may want every
merge gated on review and the full gate. A lead working in a project follows
that project's own rules. In the product, the review pipeline stays the owner's
choice: an easy setting, or a choice an agent offers while it sets them up.
Nothing here becomes a default the product imposes.

## Consequences

- A green pull request no longer waits on the Mac being on, a reviewer being
  hired, or the landing gate.
- A typecheck error or a finding can reach `main` before anything catches it;
  the `landing` run on `main` or the follow-up issue is how it gets fixed.
- The repos' agent guides, the lead guide, the quality-gates guide and the
  `codex-review` skill say merges wait on the fast checks only. No GitHub
  ruleset requires a check on these repos, so no repository setting changes.
