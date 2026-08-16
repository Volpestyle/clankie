# apps

The runnable programs: one core service plus
the surfaces that reach it. Everything here
talks to `apps/clankie` on port 4310; nothing
holds raw secrets — credentials come from the
Keychain broker.

- `clankie` — the core service: pi-based
  captain (per-lane sessions, tool bank,
  persona), the HTTP API every surface calls,
  game bodies, browser host, media generation,
  presence, pairing, file-backed memory.
- `tui` — the operator console and the
  `clankie` launcher; also the local service
  supervisor (health-gated start/restart/stop
  of service, bridge, activity, tunnel).
- `discord-bridge` — the official Discord bot
  body: /clankie slash commands, bounded text
  ingress, two-tier realtime voice with DAVE
  and per-user consent, the activity launch
  plane, possessor narration seam.
- `discord-user-session` — the personal-lab
  user-account body (ADR 0048): separate
  process, hand-rolled gateway, durable
  profile-bound owner opt-in; scopes can
  narrow but never widen.
- `discord-activity` — the watch-me-play
  surface (ADR 0047): credential-less web app
  in a voice-channel iframe; latest-only
  frames plus a thought/objective lower third.
- `gba-mcp` — the GBA body as an MCP server
  over stdio, so external harnesses play
  through the same catalogued actions, lease,
  and fail-closed limits as his free-play loop.
- `relay` — remote access for the phone and
  desktop app: authenticated HTTP/NDJSON
  boundary verifying device-session bearers
  against the service on every request.

## How they fit

The service is the only authority; surfaces
are bodies and views. Discord apps and the
relay dial into it with broker-issued
bearers; the TUI supervises it locally; the
activity surface renders frames the play
loop publishes. One mind per body at a time
is enforced by possession leases (gba-mcp,
body-lock), and denied-by-default ports keep
speech, hearing, and approvals fail-closed.
