# ADR 0243: Linear GraphQL is the tracker escape hatch

Status: accepted (James, 2026-10-06: "The linear bridge should be able to do
everything."). Tracks [VUH-1778](https://linear.app/vuhlp/issue/VUH-1778).
Amends the supported subset of [ADR 0226](0226-one-tracker-tool-surface.md).

## Context

ADR 0226 exposes one curated `linear_*` vocabulary, backed by Linear's hosted
MCP or by the registered GraphQL tracker. Neither reaches everything Linear can
do: Linear's MCP has no document delete or archive, and the curated vocabulary
has no documents at all. A worker cleaning up superseded docs could not remove
them. The MCP OAuth token is audience-restricted to `mcp.linear.app`, so it
cannot call `api.linear.app/graphql` either.

## Decision

Add one tool, `linear_graphql({ query, variables?, operationName?, confirm? })`,
to the tracker directory. It runs one GraphQL operation against
`api.linear.app/graphql` as the workspace Clankie app: the registered
`linear-api` credential first, then a workspace app stored as `linear`
(`client_credentials`). Both are `actor=app`. MCP OAuth never qualifies.

- **Lanes.** Queries run in every lane that has Linear reads. Mutations run only
  from operator tools: Clankie's own lane and admitted fleet workers, which keep
  fleet admission, the kill switch and their account-binding fence. Rooms are
  refused before dispatch.
- **Destructive mutations.** A root field matching `*Delete`, `*Archive`
  (not `*Unarchive`), `*Suspend`, `*Revoke`, `*Purge` or `*Trash` must name its
  targets through `id` or `ids`, resolved from literals, variables or variable
  defaults through aliases and fragments. `confirm` must list exactly those ids.
  An unnameable target is refused. The host logs fields and targets at dispatch.
- **One wire attempt.** The call shares `LinearRequestBudget`, which refuses
  before dispatch at the hard cap. A mutation is never retried. A definite
  provider rejection (schema validation, credentials, rate limit) returns as a
  tool error with Linear's message, secrets redacted. Network or 5xx outcomes
  are possibly dispatched and reconcile by worker receipt or a fresh read.
- **Cache.** Mutations retire tracker list snapshots like other writes; queries
  do not.
- **Backends.** It works whether `linear` is MCP passthrough or the API tracker,
  and does not depend on the MCP transport. The local backend refuses with
  "requires connected Linear"; a missing app credential refuses with the
  reconnect instruction (ADR 0226: unsupported features fail loudly).
- **Doctor.** `clankie doctor` reports whether `linear_graphql` is usable and
  which app account and credential it runs as, without probing Linear.

The curated tools stay the default. `linear_graphql` covers what they lack; it
does not replace them, and its results are raw GraphQL, not the curated shapes.

## Consequences

Any Linear operation is reachable without a new curated tool, including
irreversible ones. Owner intent for those is the caller's `confirm`, which the
host checks against the operation's real targets; it is a deliberate-intent
check and an audit trail, not a second human approval. Live document deletion
is verified on a scratch document after the change lands.
