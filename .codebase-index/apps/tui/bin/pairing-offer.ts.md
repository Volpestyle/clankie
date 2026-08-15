# apps/tui/bin/pairing-offer.ts

Client for the device pairing-offer boundary:
`requestPairingOffer()` POSTs `/v1/pairing/offer`
with the operator bearer and validates the response
against `PairingOfferWireSchema`. The offer's code
and deep link are secret-bearing display data —
rendered, never logged or persisted.

Fails closed via `PairingOfferError` with typed
statuses (`unavailable`, `unauthorized`, `expired`,
`consumed`, `revoked`, `malformed`, `interrupted`)
and secret-free messages; a non-2xx body's reason
code maps to the matching status. Also exports
`DEFAULT_CONTROL_PLANE_URL`
(`http://127.0.0.1:4310`), reused across the bin
commands. An offer already past `expiresAt` on
arrival throws `expired`.
