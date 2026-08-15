# packages/credential-broker/src/capability-token.ts

HMAC-signed short-lived capability grants.
`CapabilityGrantSchema` binds a grant to
principalId, missionId, profileHash, capabilities,
optional resources, obligations, a nonce, and an
issue/expiry window capped at
`MAX_CAPABILITY_TTL_SECONDS` (15 min).

`CapabilityTokenIssuer` (≥32-byte key) issues
`payload.signature` tokens (base64url JSON +
HMAC-SHA256) and verifies them: timing-safe
signature check, canonical-encoding check (a
noncanonical base64url form is rejected), and
not-yet-valid/expired windows — each failure a
typed `CapabilityTokenError` code. `verify`
returns the grant plus an `allows(capability,
resource?)` closure; a resource-scoped grant
requires an exact resource match.
