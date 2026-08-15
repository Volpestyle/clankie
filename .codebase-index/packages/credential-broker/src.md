# packages/credential-broker/src

Broker source. Three layers: storage
(credential-store), the capability boundary
(capability-token + audited-capabilities), and
per-identity credential modules that follow one
shared pattern — `mint*Token` (prefixed 256-bit
base64url), `resolve*` (read + pattern-validate,
refusing malformed entries), `ensure*` (first-run
bootstrap that reads back the durable value so
concurrent mints converge).

- index.ts — barrel re-exports of every module
- credential-store.ts — store interface, Keychain
  and file backends, redaction
- capability-token.ts — HMAC-signed grants
- audited-capabilities.ts — audited one-time use
- discord-bot-provider.ts — bot-token grants
- discord-user-session-provider.ts — user-plane
  grants behind a durable opt-in
- discord-bridge-credential.ts — the four bridge
  bearers (bot/voice/user/user-voice)
- captain-credential.ts — `clankie_cap_` bearer;
  env is an explicit override
- operator-credential.ts — `clankie_op_` bearer
  with rotate + secret-free status inspection
- runner-credential.ts — `clankie_runner_` bearer
- activity-producer-credential.ts — loopback frame
  producer bearer; env supply is a startup error
- possessor-voice-credential.ts — possessor voice
  seam bearer; env supply is a startup error
