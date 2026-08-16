# apps/clankie/test

Offline Vitest coverage for the service. Routes use `createStubCaptain`, state lives in temp directories, and browser, model, Discord, mail, Linear, tldraw, media, and emulator collaborators are injected fakes.

- Captain: sessions/episodes/memory, voice steering, render notices, system authority, connected tools, Herdr seat, tool detail, operator context.
- Discord: channel/presence/attachment behavior, visual context, music/social/voice clients, person memory, stream-watch and voice-receipt projections.
- Play: embodiment manager/operator routes, host round trips, sight, checkpoints, voice, activity observation, environment lifecycle.
- Capabilities: browser host, media generation, tldraw host, Linear, email.
- Trust/storage: devices, pairing, device sessions, operator auth, file memory.

The suites pin fail-closed authority and typed degradation as well as success paths; none require live Discord, provider credentials, a browser, canvas, or ROM.
