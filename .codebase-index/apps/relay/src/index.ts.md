# apps/relay/src/index.ts

Entrypoint. Builds the operator-
conversation handler (device authorizer
against `CLANKIE_CONTROL_PLANE_URL`,
captain dispatch against
`CLANKIE_CAPTAIN_URL` — both default to
the clankie service at 127.0.0.1:4310;
with no `CLANKIE_CAPTAIN_TOKEN` dispatch
fails closed), JSON-line loggers, and one
HTTP server on `CLANKIE_RELAY_HOST`
(loopback default) port 4320.

HTTP routing: `/health` returns hub
counts, then the conversation handler
claims its routes, else 404; handler
throws map to a 500 without leaking
detail. The WebSocket path is the legacy
dev tunnel: sockets must send a hello
within 5s carrying
`CLANKIE_RELAY_DEV_TOKEN` (min 16 chars;
unset disables the tunnel entirely), then
envelopes route through `RelayHub`.
