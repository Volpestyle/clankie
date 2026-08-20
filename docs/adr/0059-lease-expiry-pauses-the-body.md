# ADR 0059: Lease expiry pauses the body; only revocation is final

Status: accepted (James, 2026-07-25). Possession-specific behavior is superseded
by [ADR 0129](0129-each-player-owns-a-body.md).

## Current status (2026-08-19)

`EnvironmentRuntime` still expires, pauses, renews, and reconciles its internal
session/capability lease as described below. Each owning process now has an
independent runtime, so references to yielding a shared body, a possessor, or a
cross-process body lock are historical. The retained lease is an action and
recovery fence, not possession.

## Context

Possession-driven play includes long periods of thinking between actions. Lease
machinery must release an absent holder without destroying the in-memory game
world. Three properties define the boundary:

- **Nothing renews the environment lease.** `createFreePlaySession` takes one
  5-minute lease, and every authorized dispatch extends it.
- **Expiry runs the stop path.** An expired lease revokes the record and stops
  the adapter session only for explicit revocation. Expiry pauses the healthy
  core and preserves RAM progress.
- **The MCP server creates its session once at startup**, so recovery renews the
  same lapsed session rather than reloading the pinned savestate.

The possession lease slides in `assertMayAct`, and the tool surface exposes both
`gba_emulator_pause` and possession-gated `gba_emulator_resume`.

A driver that thinks between moves is not an anomaly to tolerate; it is the
normal shape of possession-driven play. The lease design has to survive it.

## Decision

### A lease expires for the holder, not the world

Lease expiry is a statement that the **holder** is absent — it says nothing
about the session's world, which may hold hours of unreplayable progress
([ADR 0049](0049-free-play-agency-and-non-deterministic-evidence.md)). So the
runtime separates the two consequences:

- **Expiry pauses.** A lapsed lease cancels in-flight actions and pauses the
  adapter session in place, records the lapse once (`leaseLapse`), and emits
  `environment.session.lease_expired`. The body is fenced — nothing can act —
  but the world is kept.
- **Revocation stays final.** Explicit stop, emergency stop, and adapter
  failure still revoke, and nothing recovers a revoked session. Those are
  decisions _about the session_; expiry is only the absence of its holder.

### Use renews the lease

Every authorized call re-arms the expiry, so the lease duration bounds how long
an **idle** holder keeps a claim on the body — never how long a playthrough may
run. An actively driven session cannot lapse mid-play. The possession lease
slides the same way in `assertMayAct`, so an idle possessor still yields the
body back to the resident loop while a driving one keeps it.

### `renew` re-acquires a lapsed claim

The same token that held the lease re-acquires it, subject to the same
one-writer rule as `start`:

- A lapsed claim does not block the next writer on the body, and once another
  writer has taken it, the lapsed session cannot renew back in.
- Renewal resumes only the pause the lapse itself caused. A deliberate safety
  pause — "state looks uncertain" — survives renewal and still requires an
  explicit resume from the mind that judged the state safe again.

The free-play composer makes recovery invisible at the driving seam: on
`EnvironmentLeaseExpiredError` (typed, so it can never be confused with
revocation) it renews and retries the dispatch once. A rejected dispatch is
never registered, so the retry cannot duplicate an action.

### Pausing is free, resuming is driving

`GbaDriverIo` gains `resume`, published as `gba_emulator_resume`. Stopping the
body is safe from anyone, so `gba_emulator_pause` stays lease-free; undoing a
pause lets actions flow again, so resume is gated by possession exactly like
acting.

## Consequences

- A possessor that thinks for minutes between moves loses nothing: the lease
  lapses, the body pauses where it stood, and the next action renews and
  continues. Every lapse and renewal is a semantic event, so the recovery is
  observable rather than silent.
- The lease still does its containment job. An idle holder frees the body for
  the next writer, emergency stop remains unrecoverable, and a vanished
  _process_ is still handled where it always is — body-lock liveness and
  `reconcile`.
- `ReconcileEnvironmentReport.expired` records a service restart over a lapsed
  record and pauses it rather than killing it. World state still does
  not survive process death — the GBA adapter cannot reattach an in-memory core
  — and [ADR 0060](0060-progress-as-minted-checkpoints.md) provides durable
  progress across restarts.
- Fail-closed tests assert `expired` plus successful recovery in the GBA suite.
  Separate assertions keep emergency stop terminal.
