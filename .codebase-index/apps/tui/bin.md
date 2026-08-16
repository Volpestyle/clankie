# apps/tui/bin

Headless CLI and launcher implementation. These files discover the repository, supervise owned services, issue pairing/device requests, and choose between command execution and the fullscreen console.

- `clankie.ts` — executable entrypoint and face launch.
- `devices.ts` — paired-device API helpers.
- `headless-captain.ts` — health, service, pairing, device, credential, and play commands.
- `pairing-offer.ts` — pairing-offer API helper and error mapping.
- `service-supervisor.ts` — process ownership, start/stop, and health logic.
- `services.ts` — service catalog and command orchestration.
