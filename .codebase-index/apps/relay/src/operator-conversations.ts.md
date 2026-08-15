# apps/relay/src/operator-conversations.ts

The authenticated conversation boundary:
`createOperatorConversationRelayHandler`
returns an HTTP handler owning
`/operator/v1/dispatch` and
`/operator/v1/tail` (and answering 404 to
any approval-completion-shaped path).
Every request needs a device bearer that
passes the authorizer and carries the
`chat` grant.

Dispatch: parses the strict
`OperatorConversationServiceRequest`,
forwards upstream, and for `send` runs
through `TurnIdempotencyStore` — duplicate
identical turns from one device collapse
to a single in-flight/retained result
(sha256 key, 24h TTL, 4096-entry cap,
failures evicted so retries re-dispatch).

Tail: NDJSON stream of `event`,
`recovery`, or terminal `auth_failure`
frames. Reauthorizes the device between
polls and again after each upstream fetch
before emitting, so revocation lands
before the next event. Cursor advances per
page; empty pages sleep `tailPollMs`
(250ms default); `tailMaxPages` is a test
seam.

Every result passes
`publicConversationResult`: strict schema
parse, then `redactSensitiveString` over
every string (authorization headers,
bearer/API-key shapes, session/token/
credential key-value pairs), then a second
schema parse — so an upstream leaking
private state fails closed as a 502.
Logs carry bounded, redacted metadata
only: never message text or either
credential.
