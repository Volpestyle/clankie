# apps/discord-user-session/src

Personal-lab user gateway, readiness, presence actions, shared voice composition, and Vox-backed stream discovery/watch/publish code. The directory contains no optional GPL Go Live publisher; production media control always crosses `@clankie/vox-client`.

- `gateway.ts` — bare user gateway and REST events.
- `go-live-source.ts` — publish source resolution.
- `index.ts` — process composition and local control server.
- `live-proof-cli.ts` — share-watch live-proof command.
- `live-proof.ts` — receipt evaluator.
- `presence-runtime-module.ts` — service-loadable user presence runtime.
- `readiness-cli.ts` — lab-body readiness command.
- `readiness.ts` — opt-in, credential, and allowlist checks.
- `stream-discovery.ts` — Discord stream/session discovery state.
- `stream-watch.ts` — Vox child orchestration for watch and publish.
- `user-presence-runtime.ts` — user REST and control-port presence executor.
- `voice-adapter.ts` — `@discordjs/voice` adapter for user voice.
