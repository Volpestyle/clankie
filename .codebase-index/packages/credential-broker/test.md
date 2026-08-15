# packages/credential-broker/test

Vitest suites, one per src module (all against
the file store / stubbed exec — never the real
Keychain). Broadly they pin: 256-bit prefixed
bearers that bootstrap once and resolve stably,
malformed stored credentials refused rather than
used, env-token rules (override vs hard error),
grant scoping and fail-closed denials, and audit
events that never carry caller-controlled
strings.

- credential-store.test.ts — file + keychain
  store behavior, redaction, atomicity
- capability/audited-capabilities tests — issuer
  windows, canonical encoding, one-time use,
  replay rehydration, fail-closed audit
- discord-bot-provider.test.ts — grant scoping
  and the blank-channel-allowlist semantics
- discord-user-session-provider.test.ts — opt-in
  gating incl. mid-grant revocation
- discord-bridge-credential.test.ts — four
  mutually exclusive plane bearers
- captain/operator/runner/activity-producer
  credential tests — lifecycle per bearer
