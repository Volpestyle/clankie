# ADR 0023: Captain identity changes migrate the lane registry

Status: accepted (James, 2026-07-11).

## Context

The captain lane registry persists the captain identity — agent definition,
soul, provider, and character — in its private SQLite database and refused to
open when the configured identity differed from the stored one. Any legitimate
identity change therefore bricked every captain turn until an operator edited
the database by hand: the Sapling→Clankie soul rename hit it, and switching
the model provider (`/provider` + `/model` + `/auth`) hits it on every switch
because the provider id is part of the identity.

This contradicted ADR 0014, which names `clankie restart` as the recovery
path when an older build no longer satisfies the captain identity contract.
Restart could never recover: the registry re-failed on the same stored row.

Two adjacent defects made the failure worse to diagnose. The captain lane
runtime cached a rejected setup promise for the life of the process, so even a
repaired registry kept failing until restart. And Eve swallows a throwing
dynamic model resolver — it logs server-side and serves the fail-closed
fallback model, whose static error named the model captured at agent load
time, hiding the real cause ("Captain provider changed …; restart the
captain") from the operator.

## Decision

Opening the lane registry with a changed identity migrates it in place instead
of failing closed. The new identity becomes the registry owner, and every
non-terminal lane is settled in the same transaction: state moves to
`completed` and the session id and continuation token are cleared. Each
settled lane emits `lane.session.state_changed` with reason
`identity_migrated`.

The security property the fail-closed check protected is preserved by
settlement: no session or continuation token created under the previous
identity survives the migration, so the new identity can never resume a
conversation it does not own. Per-address character mismatch, cross-lane
token/session reuse, and live-session replacement still fail closed.

The captain lane runtime no longer caches a rejected setup promise; the next
turn retries, so a repaired environment recovers without a restart. The
fail-closed fallback model surfaces the most recent dynamic resolution
failure in its error message, best-effort, instead of a static stale model
reference.

## Options weighed

- **Keep fail-closed and document manual SQL repair** — rejected: every soul,
  provider, or character change requires operator database surgery, and the
  restart recovery promised by ADR 0014 stays broken.
- **Drop the provider id from the durable identity** — rejected: provider
  switches are only one trigger; soul and character renames brick identically,
  and provider continuity still matters for continuation-token hygiene, which
  settlement handles uniformly.
- **Migrate identity but keep lanes bound** — rejected: continuation tokens
  minted under the previous identity could resume under the new one, which is
  exactly what the fail-closed check existed to prevent.

## Consequences

- `clankie restart` now genuinely recovers from identity drift, matching
  ADR 0014.
- A provider switch still requires a captain restart (the in-process runtime
  identity is fixed at startup), but the restart succeeds and the interim
  turn error names the real cause.
- An identity change abandons in-flight lane conversations by design; the
  operator notice about a fresh conversation is accurate rather than followed
  by a fatal error.
