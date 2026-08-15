# packages/credential-broker/src/operator-credential.ts

The operator bearer (`clankie_op_` + 256-bit
base64url) under `clankie_operator`. Beyond the
standard mint/resolve/ensure trio it adds:

- `rotateOperatorCredential` — atomically
  replaces the stored token; refuses while
  `CLANKIE_OPERATOR_TOKEN` overrides the store,
  because rotation cannot invalidate an
  independently managed env secret.
- `inspectOperatorCredential` — secret-free
  status (`present`, `source`, `consistency`:
  missing / store_only / env_only / consistent /
  mismatch), comparing env vs store through
  SHA-256 digests with `timingSafeEqual` so
  neither token is exposed or timing-leaked.
