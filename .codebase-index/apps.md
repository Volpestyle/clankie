# apps

The repository's runnable programs: one authoritative Clankie service plus operator, Discord, activity, game, and remote-access surfaces. Bodies authenticate to `apps/clankie` on port 4310 and keep credentials in the broker; durable state and authority remain in the service.

- `clankie/` — Pi captain, HTTP API, memory, connected services, browser/media/drawing, embodiment and play sight.
- `tui/` — `clankie` launcher, local service supervisor, and fullscreen operator console.
- `discord-bridge/` — official bot body for text, voice, music, social actions, and activity launch.
- `discord-user-session/` — opt-in lab user-account body for secondary presence, Go Live, and screen-share watching.
- `discord-activity/` — credential-free watch-me-play web surface and loopback frame ingress.
- `gba-mcp/` — possession-gated GBA body exposed as an MCP stdio server.
- `relay/` — authenticated HTTP/NDJSON boundary for phone and desktop clients.

The service is the mind and policy boundary; apps around it are transport-specific bodies and views. Shared protocol schemas keep their requests narrow, body/possession locks prevent two minds driving one surface, and absent optional capabilities fail closed or degrade honestly.
