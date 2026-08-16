# packages/discord-presence-core/src/captain-action-control.ts

Shared loopback HTTP handler for `POST
/captain-action`. `tryHandleCaptainDiscordActionRequest`
parses the host-stamped request and executor
result with protocol schemas, returns the typed
result as JSON, and collapses malformed bodies or
executor failures to a fixed 400 response.

It returns `false` for every other method/path so
the host can compose it with sibling controls.
