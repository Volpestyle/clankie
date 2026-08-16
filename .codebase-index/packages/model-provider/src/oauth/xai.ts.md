# packages/model-provider/src/oauth/xai.ts

xAI SuperGrok/X Premium subscription OAuth. It
implements RFC 8628 device authorization against
the public Grok-CLI client, polling through
`authorization_pending`/`slow_down`, refreshing
inside a two-minute skew, and storing rotated
credentials through the broker.

`createXaiFetch` reads the live broker credential
for every request, shares one concurrent refresh,
persists rotation, honors immediate revocation,
and replaces the AI SDK placeholder bearer.
`xaiAccessTokenIsExpiring` reads an unsigned JWT
`exp` only for refresh timing, never trust.

Also exports endpoint/client constants,
`requestXaiDeviceCode`, `runXaiDeviceLogin`, and
`refreshXaiToken`.
