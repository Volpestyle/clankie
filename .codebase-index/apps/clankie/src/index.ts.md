# apps/clankie/src/index.ts

Composition root: boots the whole merged service
in one process on 127.0.0.1:4310. Loads
`.env.local` (absent keys only), fills Discord
env from settings, resolves every credential from
the Keychain broker, then wires captain, app, and
play host together.

Key steps, in order:

- Mint/fetch operator, runner, and four Discord
  bridge tokens; build bearer authenticators with
  per-bridge lane identity (`discord_text` /
  `discord_voice`, bot vs user_session).
- Load or create the device-session signing key;
  missing key fails pairing routes closed (503).
- Build `ConfiguredMediaGenerator` (only when
  `CLANKIE_DISCORD_ATTACHMENT_ROOT` is set),
  browser host (on by default, degrades to
  logged unavailability), file memory, and
  optional Discord presence runtime modules
  loaded from env-named paths.
- `createCaptain()` with deps closing over a
  late-bound `boundApp()` reference — the app
  and captain are mutually dependent, but tools
  only run inside turns after boot.
- `createClankieApp()` and then a `PlayHost`
  whose embodiment "client" is the in-process
  manager itself (the loopback died with the
  split); serves pokemon-firered/emerald.
- SIGINT/SIGTERM: abort play, close the server,
  stop the play host under
  `CLANKIE_PLAY_SHUTDOWN_DEADLINE_MS` (15s
  default), then close captain, browser, app;
  exits 1 if the deadline expired.

Also re-exports the environment-lifecycle
factories.
