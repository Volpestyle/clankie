# apps/clankie/test

Vitest suites for the service, all offline by
design: routes run against `createStubCaptain()`
and temp dirs, the browser suite fakes the MCP
server on in-memory streams, and play suites use
the deterministic GBA core double — no model, no
Discord, no real browser.

- `app-smoke.test.ts` — boot-to-first-answer
  pass over the merged app.
- `discord-channel.test.ts` — channel-turn
  route: auth, dedupe, lane authority, retry.
- `captain-episodes.test.ts`,
  `discord-person-memory.test.ts` — memory
  routes and visibility fences.
- `captain-presence.test.ts` — lease manager +
  presence route.
- `devices.test.ts`, `pairing.test.ts`,
  `device-session.test.ts` — pairing flow,
  token signer, key file hygiene.
- `embodiment.test.ts`,
  `embodiment-operator.test.ts` — the
  embodiment manager and operator play routes.
- `play-host.test.ts`,
  `play-round-trip.test.ts`,
  `play-voice.test.ts` — the play host
  lifecycle, real turns on the core double
  (checkpoints, autosave, restart, body lock),
  and the ADR 0074 voice wiring.
- `browser-host.test.ts`,
  `media-generation.test.ts`,
  `discord-attachment-fetch.test.ts`,
  `activity-observation.test.ts`,
  `environment-lifecycle.test.ts`,
  `operator-auth.test.ts` — one suite per
  capability module.
