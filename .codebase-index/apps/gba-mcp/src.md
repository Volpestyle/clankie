# apps/gba-mcp/src

The server implementation: MCP tool
registration, the possession lease and its
durable log, the Discord speech/hearing
ports, and the stdio entrypoint that wires
them all to a running emulator session.

- `index.ts` — stdio entrypoint + barrel
  re-exports; boots the game, wires lease,
  body lock, frame publishing, voice.
- `server.ts` — `createGbaMcpServer`,
  registers every tool with schemas and
  descriptions.
- `tools.ts` — tool handlers: observe,
  act, pause/resume, save/load checkpoint;
  flat action-argument schema.
- `possession.ts` — `PossessionLease`:
  one holder, allowlist, TTL, force-steal.
- `possession-log.ts` — append-only
  `possession-events.jsonl` beside
  `body.lock`.
- `speech.ts` — `ClankieSpeechPort` /
  `ClankieHearingPort` seams, denied by
  default, plus `PossessorHearing`'s
  bounded transcript window.

Flow: a tool call hits `server.ts`, whose
handlers call into `tools.ts`; gameplay
handlers run `assertMayAct` (the lease)
first, then dispatch the catalogued action
through the `GbaDriverIo` runtime seam.
Nothing reaches the emulator core directly.
