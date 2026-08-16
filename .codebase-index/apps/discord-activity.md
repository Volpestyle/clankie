# apps/discord-activity

Credential-free watch-me-play web surface embedded by Discord. A public viewer server renders the latest frame/lower third, while a separate loopback bearer-gated producer server accepts frames and exposes the current PNG for the user-session Go Live source.

- `src/` — frame hub, public HTTP/WebSocket viewer, loopback producer, client, entrypoint.
- `test/` — latest-only fan-out, auth, lifecycle, snapshot, and backpressure coverage.
- `scripts/viewer-probe.ts` — live evidence probe.
- `README.md`, `package.json`, `tsconfig.json` — operating and package configuration.

The hub records nothing: it retains only the current frame/overlay, drops lagging viewer frames with counters, and invalidates state when the producer disconnects. Viewer paths work both bare and beneath Discord's `/.proxy/` prefix.
