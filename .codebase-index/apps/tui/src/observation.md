# apps/tui/src/observation

Background pollers feeding the status bar and
`/status`.

- `presence.ts` — `PresencePoller`: 5s read-only
  poll of `/v1/discord/presence-status` for the live
  presence phase.
- `herdr-roster.ts` — `HerdrRoster`: 5s poll of
  `herdr pane list` for sibling pane agents, inert
  outside HERDR_ENV=1.

Both expose `snapshot`/`snapshot()`,
`start(onChange)` (unref'd timers, callback only on
change), and `stop()`.
