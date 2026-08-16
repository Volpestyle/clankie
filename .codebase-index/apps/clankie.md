# apps/clankie

The core Node service on port 4310: Clankie's Pi captain, authority-bearing HTTP API, file-backed memory, connected Linear/email ports, browser/media/tldraw hosts, Discord projections, and GBA embodiment. `src/index.ts` composes the process; `src/app.ts` owns the wire boundary.

- `src/` — service modules and composition root.
- `src/captain/` — sessions, persona, tools, memory context, Herdr seat, and operator conversations.
- `test/` — offline Vitest suites with injected transports and temp state.
- `scripts/` — live free-play runner and local Yaak workspace generator.
- `openapi.yaml` — importable HTTP request catalog.
- `package.json`, `tsconfig*.json` — workspace/runtime configuration.

The service authenticates operator, runner, device, and Discord-body callers separately. Managers project append-only JSONL events on boot; live-only media such as screen shares stays latest-only in memory or bounded artifact files. Secrets come from the credential broker, while owner-authored settings and persona stay under `~/.config/clankie/`.
