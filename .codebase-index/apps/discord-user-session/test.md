# apps/discord-user-session/test

Offline Vitest suites for the lab body with injected sockets, Discord transport, local HTTP, and ClankVox modules.

- `gateway.test.ts` — identify/resume/heartbeat/reconnect, message/voice/raw dispatch shaping.
- `readiness.test.ts` — opt-in, scope, settings, and credential admission order.
- `user-presence-runtime.test.ts` — bare-token REST, social/music/control actions, safe refusals.
- `go-live-media.test.ts`, `go-live-source.test.ts` — optional publisher and local activity snapshot.
- `stream-discovery.test.ts`, `stream-watch.test.ts` — user-only opcodes, watching, stills, and publishing.
- `live-proof.test.ts` — real-watch plus decoded-still evidence.
