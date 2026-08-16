# apps/clankie/src/device-session.ts

Device session tokens (VUH-727): HMAC-SHA256
signed `payload.signature` tokens proving device
identity only — no grants inside, so a refresh
can never widen access and revocation kills
every token a device ever held.

Exports:

- `mintDeviceSessionClaims()` — week-long TTL,
  random nonce.
- `DeviceSessionSigner.issue/verify` — canonical
  base64url enforced, timing-safe compare,
  typed `DeviceSessionError` codes (malformed,
  invalid_signature, not_yet_valid, expired).
- `loadOrCreateDeviceSessionKey(path)` — 32-byte
  hex key in a mode-0600 regular file, opened
  O_NOFOLLOW; any deviation (symlink, wrong
  mode, garbled) returns undefined so device
  auth fails closed. Create races resolve to
  the winner's key via EEXIST.
- `COMPLETION_TOKEN_TTL_MS` (10 min) shared
  with the pairing completion window.

Kept separate from the credential-broker's
CapabilityTokenIssuer so its 15-minute ceiling
is never relaxed for day-long device sessions.
