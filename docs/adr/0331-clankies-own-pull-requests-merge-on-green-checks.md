# ADR 0331: Clankie's own pull requests merge on green checks

Status: Accepted, 2026-11-01, on James's word that the lead may set up
Clankie's own review pipeline however it wants ("you can set up the review
pipeline however you want", "just for our sdlc of clankie this is how im doing
it"). Supersedes the review gate and the merge rule of
[ADR 0329](0329-codex-reviews-on-the-owners-mac.md); its local-worker building
stays. Amends [ADR 0310](0310-ci-is-a-checkpoint-not-a-wait.md).

## Context

ADR 0329 made a Codex worker on the owner's Mac review every pull request in
clankie, clankie-app and clankie-ops, and made merging wait on its
`codex-clean` status. When no Mac reviewer could be hired, green pull requests
sat for hours with nothing left to do. The owner then left the choice of
review pipeline for Clankie's own development to the lead.

## Decision

- **A pull request merges once its checks are green.** In all three repos, a
  ready pull request with every check finished green and no conflicts with
  `main` merges, with a plain merge. Nothing else gates it, and nobody waits on
  a reviewer.
- **Local review is advisory.** A review by Codex on the Mac, OpenCode 2, Kimi,
  MiMo or any other model may run before or after a merge when one is free. Its
  findings are filed as follow-up issues at the front of the queue, by how
  badly they block the current goals, and fixed in their own pull requests.
  `codex-clean` stays an informational status; no merge waits on it, and
  `scripts/codex-review.mjs land` is optional.
- **The lead picks the reviewer, or none.** The lead may also land a change
  straight on `main` through `pnpm check:landing` (ADR 0240) with no review.
- **This is our development process only.** It describes how Clankie itself
  is built. In the product, the owner chooses their own review pipeline, as
  they choose every other part of how their agents work: an easy setting, or
  a choice an agent offers while it sets them up. Nothing here becomes a
  default the product imposes.

## Consequences

- A green pull request no longer waits on the Mac being on or a reviewer
  being hired.
- A finding can reach `main` before anyone reviews it; the follow-up issue is
  how it gets fixed, and checks on `main` (ADR 0310) still catch what tests
  cover.
- The repos' agent guides, the lead guide and the `codex-review` skill say
  merges wait on green checks only.
