# ADR 0360: Temporary views stay private to the owner

Status: recorded existing practice for #344 (2026-11-04); no sharing authority added.

## Context

A live board combines fleet capacity or tracker state that is useful to watch
but need not become a permanent document. Publishing a board could expose
private work and machine context. Letting a model supply executable page code
would add an unnecessary execution boundary.

## Decision

A view is a validated data-source and panel spec rendered by the service's own
components under the owner's authority. It is private. Titles and data are
content, not instructions or a grant. A one-off question is answered directly;
a board is for a changing state someone wants to watch.

Views expire after 24 hours by default, can live for up to seven days, and stay
indefinitely only when pinned. Expire a task's views when the task finishes.
Expiry is retention and attention management, not revocation of already
observed data. A future sharing feature needs its own audience and authority
decision; an old skill's mention of future hosted links is not authorization.

## Evidence and limits

[The view schemas](../../packages/protocol/src/views.ts) define the TTL bounds
and bounded panel/source counts. [The view store](../../apps/clankie/src/views.ts)
implements expiry and pinning; [the shipped skill](../../.agents/skills/views/SKILL.md)
describes the CLI. These are implementation evidence on main `c979eeaba`, not a
usage study proving 24 hours is optimal. Owner privacy follows
[ADR 0300](0300-clankie-runs-only-on-the-owners-machine.md); no hosted body or
public share service is implied.

## Revisit when

- Actual use shows temporary boards expiring before their task ends or piling
  up after it ends; measure retention and pinning before changing the TTL.
- A new source or renderer needs a permission boundary beyond the owner's
  existing read authority, or sharing is requested. Review that boundary before
  allowing other audiences or executable content.
