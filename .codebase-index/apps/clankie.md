# apps/clankie

The core service: one Node process on port 4310
that is Clankie's body. It hosts the pi-based
captain (sessions, tools, persona), the HTTP API
every surface calls, the embodiment play host
(GBA/Minecraft), a browser host, media
generation, presence projections, and file-backed
memory.

- `src/` — all service code; `index.ts` is the
  composition root, `app.ts` the HTTP surface.
- `src/captain/` — the pi captain: sessions,
  tool bank, persona instructions, lane logs.
- `test/` — vitest suites, offline by design
  (stub captain, fake MCP server, core double).
- `scripts/` — `free-play-live.ts`, the dev
  entrance to the play execution.
- `package.json`, `tsconfig.json`,
  `tsconfig.captain.json` — workspace config.

Architecture: `index.ts` wires credentials
(Keychain broker), the captain, browser host,
media generator, memory, and the play host into
`createClankieApp()`. Everything the runner once
did over a loopback is now an in-process port.
State is an append-only JSONL event log replayed
into projections on boot (devices, Discord
presence, embodiment, captain presence).
Authentication is per-caller bearer tokens:
operator, runner, four Discord bridges, and
signed device-session tokens from pairing.
