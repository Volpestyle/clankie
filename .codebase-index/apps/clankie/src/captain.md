# apps/clankie/src/captain

Pi-based captain runtime and its durable operator/room seams. It binds service-owned tools and authority to model sessions while keeping lane history, Herdr seat context, and operator conversations explicit.

- `captain.ts` — captain lifecycle and turn orchestration.
- `connect-tools.ts` — connected-service tool definitions.
- `conversations.ts` — file-backed operator conversation registry.
- `deps.ts` — captain dependency contracts.
- `discord-turn.ts` — Discord-specific turn shaping.
- `herdr-census.ts` — live Herdr pane census.
- `herdr-seat.ts` — originating operator pane context.
- `herdr-summaries.ts` — bounded pane summaries for context.
- `instructions.md` — captain system instructions.
- `lane-log.ts` — durable heard/said lane trails.
- `model.ts` — model/session construction.
- `play.ts` — play-related captain tools.
- `port.ts` — captain port contract.
- `system-authority.ts` — trusted actor and machine-tool authority.
- `tools.ts` — core captain tool catalog.
