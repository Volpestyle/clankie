# packages/credential-broker/test/operator-credential.test.ts

Operator-bearer lifecycle: high-entropy first-run
mint then auto-load; env override reported as a
mismatch without exposing either token; rotation
replaces the store in one write and invalidates
the old token; malformed credentials and rotation
under an env override fail closed; a minted token
stays redacted even when the store includes it in
a write-failure message.
