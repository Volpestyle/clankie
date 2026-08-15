# apps/tui/src/observation/presence.ts

`PresencePoller` — a small read-only poll (5s,
2s timeout) of the clankie service's
`/v1/discord/presence-status` projection, operator-
authenticated. The snapshot is just `{phase}`:
prefers a live phase (`present`, `voice_active`,
`go_live_active`), else reports the first session's
phase verbatim, `"no presence session"` when none,
or `undefined` when unauthenticated/unreachable.
Feeds the status bar and `/status`.
