# apps/clankie

Authoritative Clankie service and composition root. It owns the Pi captain, authenticated HTTP API, durable conversations and memory, browser/media/drawing tools, Discord projections, device pairing, and the in-process GBA play host; external worlds such as PokeAgent MMO remain behind generic MCP.

- `openapi.yaml` — public and authenticated HTTP contract.
- `package.json` — service scripts and workspace dependencies.
- `scripts/` — service-focused operational utilities.
- `src/` — service implementation and composition.
- `test/` — unit, integration, and architecture tests.
- `tsconfig.captain.json` — captain-focused TypeScript configuration.
- `tsconfig.json` — app TypeScript configuration.
