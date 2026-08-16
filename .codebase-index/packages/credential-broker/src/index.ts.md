# packages/credential-broker/src/index.ts

Barrel file: re-exports every broker module —
stores and redaction, the capability
issuer/broker, the Discord bot and user-session
providers, and each internal bearer's
mint/resolve/ensure trio with its provider id and
typed error class. No logic of its own.
