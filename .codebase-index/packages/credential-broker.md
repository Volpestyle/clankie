# packages/credential-broker

`@clankie/credential-broker` — the local secret
boundary. Provider credentials live in the macOS
Keychain (JSON file fallback); trusted adapters
receive short-lived signed capability grants
instead of raw tokens; and every internal Clankie
bearer (captain, operator, runner, bridges,
activity producer, possessor voice) is minted and
resolved here rather than hand-exported.

Children:

- README.md — storage, bearers, capability rules
- package.json / tsconfig.json — zod-only, ESM
- src/
  - credential-store.ts — Keychain + file stores
  - capability-token.ts — HMAC grant issuer
  - audited-capabilities.ts — fail-closed,
    audited one-time use broker
  - discord-bot-provider.ts — bot-token grants
  - discord-user-session-provider.ts — user-plane
    grants gated on a durable owner opt-in
  - discord-bridge-credential.ts — the four
    bridge-plane bearers
  - captain-credential.ts, operator-credential.ts,
    runner-credential.ts — service bearers with
    first-run bootstrap
  - activity-producer-credential.ts,
    possessor-voice-credential.ts — loopback
    bearers that refuse env supply
  - index.ts — barrel re-exports
- test/ — one suite per module

Architecture: secrets never enter environments,
logs, or config; `list()` only ever returns
redacted summaries; grants are bounded to 15
minutes and bound to principal + mission +
profile hash; env-supplied tokens are either an
explicit override (captain/operator) or a hard
startup error (activity producer, possessor
voice), never a silent preference.
