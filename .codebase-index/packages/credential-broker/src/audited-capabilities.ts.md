# packages/credential-broker/src/audited-capabilities.ts

`AuditedCapabilityBroker` — the fail-closed
runtime boundary over `CapabilityTokenIssuer`. No
token or allowed decision is returned until its
redacted audit event (`capability.issued`,
`capability.use.allowed/denied`) has durably
appended to the injected `CapabilityAuditSink`.

Details:

- `issue(grant, context)` requires the grant's
  principal/mission/profileHash to match the
  trusted audit context, then logs SHA-256
  fingerprints of grant/capability/resource/
  obligation ids — never the caller's strings.
- `authorizeUse(request, context)` verifies the
  token, checks mission/principal/profile match,
  then enforces one-time use: per-grant queues
  serialize same-process use, consumption is
  rehydrated from `capability.use.allowed` events
  after restart, and a failed append rolls the
  in-memory consumption back unless another
  broker durably consumed it first (then
  `replayed`).
- Every deny carries a typed
  `CapabilityUseReason` (token error codes plus
  mismatch/not-granted/replayed).
