# apps/clankie/src

The merged service's code: composition root,
HTTP surface, and one module per capability —
play, browser, media, memory, presence, devices.
The old control-plane/runner split is gone;
everything runs in one process and talks through
in-process ports.

- `index.ts` — composition root; wires
  credentials, captain, hosts, and serves :4310.
- `app.ts` — every HTTP route, auth, and the
  JSONL event log with boot replay.
- `captain/` — the pi captain (own entry).
- `embodiment.ts` — asked-play authority: intent
  → session lifecycle, event-sourced.
- `play-host.ts` — claims play work and runs it;
  `play-execution.ts` — the actual GBA
  playthrough (lock, boot, checkpoints, frames,
  voice, journal).
- `browser-host.ts` — owns the agent-browser MCP
  server over stdio JSON-RPC.
- `media-generation.ts` — image/video generation
  from operator-configured models.
- `memory.ts` — file-backed person facts and
  captain episodes.
- `activity-observation.ts` — latest-only "what
  is on his screen" projection.
- `captain-presence.ts` — captain heartbeat
  lease manager.
- `discord-presence-session.ts`,
  `discord-presence-runtime.ts`,
  `discord-user-session-opt-in.ts`,
  `discord-attachment-fetch.ts` — Discord
  presence projections, executor port, opt-in
  record, and the SSRF-hardened attachment
  fetcher.
- `devices.ts`, `device-session.ts`,
  `pairing.ts`, `operator-auth.ts` — device
  pairing, HMAC session tokens, and operator
  credential auth.
- `environment-lifecycle.ts` — GBA/Minecraft
  environment-runtime compositions.

Flow: a surface (bridge/TUI/relay/device) hits a
route in `app.ts`; routes authenticate, validate
with protocol schemas, and call either the
captain port or an in-process manager. Managers
emit domain events to the JSONL log and rebuild
their projections from it on boot.
