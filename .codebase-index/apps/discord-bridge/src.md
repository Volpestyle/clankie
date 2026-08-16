# apps/discord-bridge/src

The official bot process and side-effect-free composition modules.

- `index.ts` — startup guards, gateway/ingress assembly, slash dispatch, catch-up loop, music/action control, voice and playthrough text wiring.
- `commands.ts`, `authority.ts`, `text.ts`, `attachment-resolver.ts` — command shape, policy tiers, sanitization, and hash-bound files.
- `bot-presence-runtime.ts`, `presence-runtime-module.ts` — Discord REST executor and service-loaded capability module.
- `voice-composition.ts` — realtime/transcription/TTS ports, briefing/screen-look providers, idle leave, receipts, disclosure text.
- `voice-presence.ts` — captain-requested join/leave using fresh gateway state.
- `possessor-text.ts` — admitted room speech to active gameplay.
- `clankvox-ipc.ts` — framed media-sidecar contract.
- `readiness.ts`, `voice-readiness.ts`, `live-proof.ts` — fail-closed evidence evaluators.
- `*-cli.ts` — thin JSON/stdout wrappers for readiness and proof runs.

Gateway messages enter shared `DiscordTextIngress`; active-body control requests remain loopback-only. Voice keeps the dormant-listener/engaged-session architecture, with optional ElevenLabs speech, bounded retention, idle auto-leave, and content-free latency/token evidence.
