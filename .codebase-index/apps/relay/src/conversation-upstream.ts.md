# apps/relay/src/conversation-upstream.ts

The upstream hop:
`createCaptainConversationDispatch` returns
an `OperatorConversationServiceDispatch`
that POSTs registry requests to the
captain-owned conversation endpoint with
the relay's own bearer (min 16 chars,
enforced at construction) — the device
credential never rides this hop.

http/https only, 30s timeout, non-2xx
throws, and every response is parsed
against
`OperatorConversationServiceResultSchema`
before it is trusted.
