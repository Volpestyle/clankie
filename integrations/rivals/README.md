# Rivals game extension

The common `GameExtension` wraps typed high-level objectives and the original
Rivals session-server lifecycle. It never changes the native controller policy
or uses the turn-based play kernel. Core supplies the broker-private HTTP port,
captured conversation authority, durable shared play lease and exact receipt
persistence. Metadata is inert; Activity remains the native read-only watch path.

Native `Session._run` marks `stopped` before cleanup, then writes `endedAt` after
pad/capture release. Cleanup failure changes the phase to `failed`. The adapter
requires matching execution, session ID, request ID and start time with `stopped`,
no error and `endedAt`; no other reply frees ownership. A stop request is scoped
to that original controller. Lost start replies recover using the persisted
unguessable request nonce; missing/replacement records remain uncertain.

See [the operator guide](../../docs/rivals.md) and
[ADR 0234](../../docs/adr/0234-games-share-one-extension-contract.md). The bridge
remains disabled. Isolated HTTP verification does not authorize live PC runs.
