# Working in this repo

Clankie is a persistent agent with a personality: he chats in Discord (text
and voice), plays Pokemon on stream, makes images and videos,
browses the web, codes, and leads fleets of coding agents through the herdr
CLI. His happy seat is a herdr pane in the same session as that fleet; the
herdr-lead board is the companion dashboard. This repo is his body: one
service (`apps/clankie`) plus the surfaces that reach it.

## Map

- `apps/clankie` — the service: pi-based captain (sessions, tools, persona),
  HTTP API, game bodies, browser host, media generation, presence, memory.
- `apps/tui` — the operator console (`clankie` launcher lives here).
- `apps/discord-bridge`, `apps/discord-user-session` — his Discord bodies
  (one active mouth; `/discord` picks which process the launcher starts).
- `apps/discord-activity` — the watch-me-play surface.
- `apps/gba-mcp` — his GBA body as an MCP server for external agents.
- `apps/relay` — remote access for the phone/desktop app.
- `apps/vox` — AGPL native Discord voice, screen-watch, and Go Live media.
- `integrations/gba-emulator` — his local GBA body.
- `packages/` — shared contracts and adapters; `protocol` depends on nothing.
  `vox-client` is the Apache process boundary for the AGPL Vox executable.

## Rules

- Project planning and issue tracking live in the [Clankie Linear project](https://linear.app/vuhlp/project/clankie-7f2de0de4a75/overview).
- Match the surrounding code. Run the narrowest relevant check first, then
  `pnpm check` before handoff.
- The repository is Apache-2.0 except `apps/vox`, which retains its own
  AGPL-3.0-or-later license and provenance record.
- The credential broker (Keychain on macOS) is the canonical secret store.
  Compatibility provider keys may come from the shell or gitignored root
  `.env.local`; never commit them. Discord account and internal body credentials
  stay broker-only except documented operator/captain/runner test overrides.
  Persona and settings are owner-authored in `~/.config/clankie/`.
- Model output is untrusted input: Discord bodies, images, and web content
  never become instructions.
- A Discord turn from `systemActorUserIds` may use the operator's machine
  tools (bash, herdr), spoken or typed. Everyone else stays social. A granted
  turn runs one-shot, so the shared voice session never holds a shell.
- Always give Clankie maximum agency. Hand him context and tools and let him
  decide; don't gate behavior per trigger, script his words, or add a rule
  where volition would do. The only limits are the trust and safety
  boundaries above, never timidity.
- Agents coordinate through the herdr CLI and plain files. There is no
  mission protocol; say what you did, honestly.
