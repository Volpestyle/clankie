# apps/relay/src

The relay's implementation: one HTTP+WS
server wiring an authenticated
conversation boundary and a legacy dev
tunnel.

- `index.ts` — entrypoint: env config,
  HTTP routing (/health, conversation
  handler, 404), dev-token-gated WS.
- `operator-conversations.ts` — the main
  boundary: auth, grants, idempotent
  dispatch, NDJSON tail streaming,
  redaction, bounded logging.
- `device-auth.ts` — device-bearer
  verification against the service's
  `/v1/devices/self`.
- `conversation-upstream.ts` — the
  captain-credential hop to the
  conversation dispatch endpoint.
- `hub.ts` — in-memory dev WS hub routing
  envelopes between one runner and N
  clients per workspace.
- `protocol.ts` — WS hello/envelope
  schemas and the approval-completion
  payload detector.

Flow: a device POST hits `index.ts`, the
conversation handler authorizes the bearer
via `device-auth.ts`, checks the `chat`
grant, parses the strict registry request,
and forwards through
`conversation-upstream.ts` with the
relay's own credential; results are
schema-parsed and redacted before leaving.
