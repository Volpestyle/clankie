# apps/clankie/test/devices.test.ts

The full device pairing surface over the routes
with a JSONL event log as the durable store:
offer → redeem → complete → refresh → revoke
(both old and new tokens die), typed-code
normalization, grant-free tokens, refresh
reading grants from the projection so it can
never widen.

Misuse coverage: replayed offers read consumed,
unknown/aged read expired, restarts invalidate
outstanding offers; completion-token replay,
expiry, revoked-while-pending, and
terminalControl denied without consuming the
token (with an audit event). Also: device
isolation, identical state rebuilt across
restart, expired pendings omitted, fail-closed
without a signing key, no secret ever in the
event log, and revoke-vs-refresh races staying
coherent.
