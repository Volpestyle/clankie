# ADR 0361: A play sitting has a bounded model budget

Status: recorded existing practice for #344 (2026-11-04); no play policy changed.

## Context

A game can run indefinitely, and a provider outage or invalid decision loop
can spend model calls without advancing it. Stopping a play sitting must remain
distinct from terminating the shared world or proving its controls are free.

## Decision

The owner can set the next sitting's token and dollar budgets. The current
default is 250,000 charged model tokens. Commentary and interrupted proposals
still cost usage; an unknown call reserves 16,000 tokens and stops a
dollar-capped sitting rather than treating missing usage as free. The last call
can cross a threshold: this is a bounded decision loop, not an exact prepaid
billing ceiling.

Five consecutive failed or invalid model decisions stop play after exponential
backoff; a valid decision resets the counter. Budget exhaustion, unavailable
mind and world departure stay distinct terminal observations. These bounds do
not choose the mind's game actions or prove that a failed driver has relinquished
its session. The exact-session recovery and lease rules of
[ADR 0215](0215-conversations-lease-one-body.md) and
[ADR 0234](0234-games-share-one-extension-contract.md) still apply.

## Evidence and limits

[The play loop](../../packages/play/src/free-play.ts) implements the consecutive
failure stop, and [usage accounting](../../packages/play/src/free-play-usage.ts)
handles unknown usage. [The shipped skill](../../.agents/skills/pokeagents/SKILL.md)
records the configurable defaults. These are implementation evidence on main
`c979eeaba`. There is no retained comparative experiment establishing that
250,000 tokens, 16,000 reserved tokens or five failures are optimal across
models; do not present these values as measured universal limits.

## Revisit when

- A model's context, pricing or usage-reporting changes, particularly if its
  ordinary calls exceed the unknown-usage reserve.
- Real sittings repeatedly exhaust the budget before useful play, or retain
  repeated failures without progress. Compare charged usage, failure runs and
  completed objectives before changing the values.
- The world or driver changes its termination contract. A new retry policy
  must preserve uncertain ownership and exact-session recovery.
