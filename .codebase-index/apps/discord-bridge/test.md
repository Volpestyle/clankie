# apps/discord-bridge/test

Offline Vitest suites using injected REST, gateway, realtime, TTS, and media seams.

- Authority/ingress: `authority`, `commands`, `subcommand-authority`, `attachment-resolver`, `possessor-text`.
- Presence/actions: `bot-presence-runtime`, `presence-runtime-module`, `voice-presence`.
- Voice/media: `voice-composition`, `voice-readiness`, and `voice-realtime-wiring` on the maintained Discord media stack.
- Evidence: `readiness` and `live-proof`.

The suites pin exact transport identity, consent/policy gates, retired configuration rejection, bounded lifecycle behavior, and content-free evidence without logging into Discord.
