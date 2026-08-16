# apps/discord-bridge/src

Official-bot gateway, ingress, commands, presence execution, voice composition, readiness, and evidence code. Transport-neutral reaction encoding and common voice configuration/providers now come from `@clankie/discord-presence-core`.

- `attachment-resolver.ts` — bridge attachment resolution.
- `authority.ts` — Discord actor and channel authority checks.
- `bot-presence-runtime.ts` — bot REST presence action executor.
- `commands.ts` — slash-command registration and handlers.
- `index.ts` — official-bot process composition.
- `live-proof-cli.ts` — text/person-memory/voice receipt evaluator CLI.
- `live-proof.ts` — content-free live-proof evaluators.
- `possessor-text.ts` — gameplay possessor text seam.
- `presence-runtime-module.ts` — service-loadable presence runtime factory.
- `readiness-cli.ts` — text readiness command.
- `readiness.ts` — bot/service/config readiness inspection.
- `text.ts` — Discord text transport adapter.
- `voice-composition.ts` — bot-specific realtime/TTS wiring and disclosures.
- `voice-presence.ts` — bot voice session integration.
- `voice-readiness-cli.ts` — voice readiness command.
- `voice-readiness.ts` — voice dependency and live wake probe.
