# packages/credential-broker/test/credential-store.test.ts

Store tests over `FileCredentialStore`,
`KeychainCredentialStore` (with a stubbed
`execFile`), and `createDefaultCredentialStore`:
typed credential round-trips for api/oauth/
wellknown, providerId normalization, redacted
listings, atomic writes and permissions, corrupt
files refused, invalid entries skipped and
surfaced, and index consistency for the keychain
backend.
