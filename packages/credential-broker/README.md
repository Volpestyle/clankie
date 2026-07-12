# @clankie/credential-broker

The credential broker is the local secret and short-lived capability boundary.
Provider credentials stay in the macOS Keychain by default; workers receive
signed grants that name only their mission, worker-run identity, doctrine hash, allowed
capabilities, optional resources, policy obligations, and expiry.

## Credential storage

- `KeychainCredentialStore` stores one generic-password item per provider and a
  serialized provider index. Operations sharing a service are queued across
  in-process store instances. Creation writes the index before the secret, and
  deletion removes the secret before pruning the index, so a partial failure
  cannot leave an unindexed credential behind.
- `FileCredentialStore` is the non-macOS/CI fallback. It writes atomically with
  collision-proof temporary names, serializes same-path writers, enforces mode
  `0600` inside a mode-`0700` directory, and never returns secrets from `list()`.
- `createDefaultCredentialStore()` selects Keychain on macOS. Setting
  `CLANKIE_CREDENTIALS_FILE` explicitly selects the file backend.
- Credential summaries pass through `redactCredential()` before entering a UI
  or structured log.

The Keychain implementation invokes `/usr/bin/security` through `execFile`, not
a shell. Secret JSON is passed as a single argv value because the CLI has no
non-interactive stdin form; it is never placed in a worker environment or
written to a plaintext config file.

## Capability boundary

`CapabilityTokenIssuer` signs and verifies bounded HMAC grants. Resource-scoped
grants require the caller to present an exact resource; omitting a resource does
not widen a grant. Tokens are rejected before `issuedAt` and at or after
`expiresAt`, use canonical base64url encoding, and have a maximum 15-minute
lifetime. Signed obligation identifiers travel with the grant so a privileged
connector receives the policy constraints attached to the original allow
decision. A doctrine-hash mismatch invalidates the grant immediately.

`AuditedCapabilityBroker` is the runtime entry point:

1. `issue()` appends a redacted `capability.issued` event before returning the
   token.
2. `authorizeUse()` binds the token to the calling mission and worker run, then
   appends `capability.use.allowed` or `capability.use.denied` before returning a
   decision.
3. An allowed grant is consumed once. Consumption is rehydrated from the event
   log after restart. Same-process broker instances serialize use of the same
   grant, while a deterministic allowed-event ID lets the durable SQLite event
   store resolve cross-process races fail-closed.
4. If the event sink fails, issuance and authorization fail closed.

Audit events include SHA-256 fingerprints for grant, capability, and resource
and obligation identifiers plus trusted mission/worker correlation and expiry. Caller-controlled
strings are never copied into event data, so a malicious resource cannot smuggle
a signed token, nonce, or provider credential into the log. The
`CapabilityAuditSink` shape is compatible with the append/read surface of
`@clankie/event-store` without coupling the two sibling infrastructure packages.
The JSONL event store remains a single-writer development backend; production
multi-process authorization uses SQLite's atomic event-ID uniqueness.
