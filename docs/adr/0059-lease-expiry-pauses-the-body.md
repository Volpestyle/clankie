# ADR 0059: Lease expiry pauses the body; only revocation is final

Status: accepted (James, 2026-07-25). Implemented in the environment runtime,
the free-play session composer, and the GBA MCP server, with the recovery paths
covered by tests.

## Context

An external harness played FireRed through the MCP surface
([ADR 0053](0053-mcp-possession-of-clankies-body.md)) and hit a wall that had
nothing to do with the game: it stopped to read map code between moves, and when
it came back the session was dead — permanently.

Three properties of the lease machinery compounded into that:

- **Nothing renewed the environment lease.** `createFreePlaySession` took one
  5-minute lease and no dispatch path ever extended it, so every session carried
  a fixed-length fuse regardless of activity. The composer even carried a
  comment naming the constraint and deferring it.
- **Expiry ran the stop path.** An expired lease revoked the record and stopped
  the adapter session, exactly like an explicit stop — while the core, its RAM,
  and the game's progress sat healthy in the same process. Every later call,
  including a fresh possession, authorized against the revoked record and was
  refused.
- **The MCP server creates its session once at startup**, so the only recovery
  was restarting the process, which reloads the pinned savestate and loses the
  world.

The possession layer had the milder form of the same bug — a fixed TTL that
`assertMayAct` never slid — and the tool surface had a one-way valve:
`gba_emulator_pause` existed with no resume, so a stated-reason pause also
bricked acting for a possessor.

A driver that thinks between moves is not an anomaly to tolerate; it is the
normal shape of possession-driven play. The lease design has to survive it.

## Decision

### A lease expires for the holder, not the world

Lease expiry is a statement that the **holder** went away — it says nothing
about the session's world, which may hold hours of unreplayable progress
([ADR 0049](0049-free-play-agency-and-non-deterministic-evidence.md)). So the
runtime now separates the two consequences that were previously fused:

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
revocation) it renews and retries the dispatch once. A rejected dispatch was
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
  _process_ is still handled where it always was — body-lock liveness and
  `reconcile`.
- `ReconcileEnvironmentReport.stoppedExpired` is now `expired`: a runner restart
  over a lapsed record pauses it rather than killing it. World state still does
  not survive process death — the GBA adapter cannot reattach an in-memory core
  — and durable progress across restarts remains a separate, undecided concern.
- The frozen fail-closed tests changed meaning deliberately: lease loss now
  asserts `expired` plus successful recovery, in both the GBA and PokeMMO
  suites. The emergency-stop assertions are untouched.
