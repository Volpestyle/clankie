# apps/clankie/test/device-session.test.ts

Unit tests for the device session signer and key
file. Signer: roundtrip, wrong-key/tampered/
noncanonical/extra-segment rejection with typed
codes, expiry and not-yet-valid, week-long
default TTL, minimum key length.
`loadOrCreateDeviceSessionKey`: mints a stable
mode-0600 hex key, rejects wrong-mode, symlinked,
or garbled files (fail closed → undefined), and
resolves a concurrent create race to one shared
key.
