# apps/clankie/src

Service implementation for Clankie's mind, API, durable projections, connected tools, and in-process GBA body. `index.ts` wires these modules into one loopback process; transport-specific Discord gateways remain separate apps.

- `activity-observation.ts` — latest gameplay activity projection.
- `app.ts` — Hono routes, authentication, and service facade.
- `browser-host.ts` — owned agent-browser tool host.
- `captain-presence.ts` — captain presence lifecycle projection.
- `captain/` — Pi captain, tools, lanes, conversations, and Herdr context.
- `device-session.ts` — signed paired-device session handling.
- `devices.ts` — durable paired-device projection and grants.
- `discord-attachment-fetch.ts` — bounded Discord attachment resolution.
- `discord-captain-actions.ts` — captain-to-Discord semantic action client.
- `discord-music.ts` — captain music-control client.
- `discord-presence-runtime.ts` — privileged presence runtime port.
- `discord-presence-session.ts` — service-side presence state.
- `discord-user-session-opt-in.ts` — durable personal-lab opt-in policy.
- `discord-voice-presence.ts` — captain voice join/leave client.
- `email.ts` — email connection port.
- `embodiment.ts` — asked-play session authority.
- `index.ts` — process composition, startup, and shutdown.
- `linear.ts` — Linear connection port.
- `media-generation.ts` — configured image/video generation.
- `memory.ts` — file-backed person and episode memory.
- `operator-auth.ts` — broker-backed operator authentication.
- `pairing.ts` — one-time device pairing flow.
- `play-execution.ts` — GBA play execution adapter.
- `play-host.ts` — persistent asked-play loop.
- `play-sight.ts` — current still/story projection.
- `stream-watch-observation.ts` — retained Discord share samples.
- `tldraw-host.ts` — owned diagram tool host.
- `voice-receipt-activity.ts` — voice receipt activity projection.
