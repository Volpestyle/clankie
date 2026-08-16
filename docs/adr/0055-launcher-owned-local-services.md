# ADR 0055: The launcher owns every local service

Status: accepted (James, 2026-07-25). Applies to the single-service pi
architecture.

## Context

Clankie is present through several long-lived local processes. Starting them by
hand leaves no durable ownership record, no dependency-aware restart, and no
reliable health gate.

![ADR 0055: The launcher owns every local service](../diagrams/0055-launcher-owned-local-services.jpg)

## Decision

`apps/tui/bin/service-supervisor.ts` owns the process mechanics and
`apps/tui/bin/services.ts` declares the services and their dependency order.
The backend is one `clankie` process: the HTTP API, pi captain, presence state,
media, and game bodies all live there. The Discord bridge depends on it. The
optional lab user-session body depends on it too and stays off until enabled
([ADR 0098](0098-user-session-watches-discord-shares.md)). The activity
surface and tunnel publish what he plays.

Every managed process gets:

1. an atomically written mode-0600 pid record under the Clankie state root;
2. a live command check before any signal, so a recycled pid cannot kill an
   unrelated process; and
3. a service-specific health gate before start succeeds.

Restart follows dependencies. Restarting `clankie` also restarts the bridge
and the lab user-session body, because both hold live claims against the
service instance. Stopping one named service remains scoped to that service.

The compatibility aliases `captain`, `captain-eve`, `eve`, `control-plane`, and
`cp` all resolve to `clankie`; they do not name separate processes.

## Consequences

- `clankie restart` and `clankie status` cover the full local stack.
- A process started outside the launcher is reported but never adopted or
  killed.
- Settings remain the source of Discord allowlists; the launcher supplies only
  repository paths and brokered service credentials.
