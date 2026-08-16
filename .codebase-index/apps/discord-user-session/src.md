# apps/discord-user-session/src

The user-account body and its transport-specific media stack.

- `index.ts` — admission, gateway/ingress, operator-driven voice, music/control port, stream wiring, shutdown.
- `gateway.ts` — auditable identify/resume/heartbeat client plus raw dispatch and voice-state access.
- `readiness.ts`, `readiness-cli.ts` — ordered fail-closed opt-in/config/credential gates.
- `user-presence-runtime.ts`, `presence-runtime-module.ts` — bare-token REST executor and service capability wrapper.
- `voice-adapter.ts` — gateway-to-`@discordjs/voice` seam.
- `stream-discovery.ts`, `stream-watch.ts` — Go Live opcode catalog and watch/publish lifecycle.
- `clankvox-sidecar.ts` — external sidecar framing and process control.
- `go-live-source.ts`, `go-live-media.ts` — local activity PNG source and optional publisher stack.
- `live-proof.ts`, `live-proof-cli.ts` — decoded-still evidence gate.

The body can watch a share muted/deafened while the official bot remains the mouth. When it is the active mouth it can publish local activity or a URL; every media path is optional and reports an explicit unavailable/incomplete state.
