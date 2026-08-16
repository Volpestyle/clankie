# packages/possessor-voice

Canonical authenticated loopback seam between a GBA possessor and whichever Discord body owns live voice. The possessor reports gameplay events and receives already-consented attributed room text/state without gaining gateway authority, raw audio, audience selection, or durable replay.

- `package.json` — WebSocket seam dependencies and scripts.
- `README.md` — wire, credential, loss, and evidence guide.
- `src/` — brokered client and bridge listener.
- `test/` — auth, bounds, loss, and delivery tests.
- `tsconfig.json` — TypeScript configuration.
