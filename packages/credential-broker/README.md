# @clankie/credential-broker

The credential broker is the local secret and short-lived capability boundary.
Provider credentials stay in the macOS Keychain by default; trusted adapters
receive signed grants that name only their principal, profile hash, allowed
capabilities, optional resources, and expiry.

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

## Local operator credential

The broker owns the `clankie_operator` bearer used by trusted local operator
surfaces. The first service start and the fullscreen launcher mint 256
bits of cryptographic entropy when the entry is absent. The clankie service and
TUI resolve that same entry automatically; `CLANKIE_OPERATOR_TOKEN` is an
explicit CI/test override and is never persisted by bootstrap.

`clankie health` reports only presence, selected source, and whether an env
override matches the stored value. `clankie operator-credential rotate`
atomically replaces the broker entry without printing it. The service
resolves the entry at each authenticated operator request, so rotation rejects
the old token immediately and the next CLI request loads the replacement.
Rotation refuses to run while an env override is active because a stored
replacement cannot invalidate an independently managed environment secret.

The Keychain implementation invokes `/usr/bin/security` through `execFile`, not
a shell. Secret JSON is passed as a single argv value because the CLI has no
non-interactive stdin form; it is never placed in a child process environment or
written to a plaintext config file.

## Discord providers

`discord_bot` stores the official bot token as an API credential. The trusted
presence adapter issues `discord.presence.act` or `discord.presence.read` grants
bound to a principal, profile hash, expiry, and explicit
`discord:guild:*` / `discord:channel:*` resources. The provider refuses resources
outside its configured allowlists and resolves connection material only after a
matching grant is verified. The token is never placed in a captain, service,
or bridge process environment.

`clankie_discord_bridge` is a separate, broker-owned local bearer. The clankie
service creates it on first start and authenticates it only as the
`discord-bridge` captain on the `discord_text` lane. The bridge resolves it
directly from the broker after the service starts. It is never supplied
through `CLANKIE_CAPTAIN_TOKEN`, so Discord cannot inherit another captain's
identity or source lane.

`clankie_discord_voice_bridge` is a second broker-owned local bearer with a
distinct `discord_voice` service identity. Official-bot voice ingress
cannot reuse the text bridge bearer, and the text bridge cannot submit a
`voice_event`. The bridge resolves both internal credentials directly from the
store after the service starts; neither enters an environment variable.
OpenAI transcription and speech reuse the brokered `openai` API credential
inside the voice process and never expose it to the captain. When the
external voice is configured ([ADR 0070](../../docs/adr/0070-external-voice-via-streaming-tts.md)),
ElevenLabs speech synthesis uses the brokered `elevenlabs` API credential the
same way — connection headers only, and the `ELEVENLABS_API_KEY` / `XI_API_KEY`
environment names are hard startup errors in the bridge.

`discord_user_session` holds the personal-lab normal-user credential
([ADR 0048](../../docs/adr/0048-discord-user-session-transport.md)).
`DiscordUserSessionCredentialProvider` mirrors the bot provider — expiring,
resource-scoped grants exchanged only by the trusted transport adapter — and
adds one gate the bot plane does not need: a durable owner opt-in bound to the
recorded profile hash, re-checked at redemption so a revocation stops the very
next action instead of waiting for grant expiry. A `DISCORD_USER_TOKEN`
environment variable is a startup error in every process that could reach it.

`clankie_discord_user_bridge` and `clankie_discord_user_voice_bridge` are the
user plane's local bearers, distinct from the bot plane's pair. The service
derives `transportKind` from which bearer authenticated, so a request body
cannot claim a transport it does not hold. All four bearer patterns are mutually
exclusive: `clankie_discord_` prefixes every one of them, and an unanchored
match would let a user-plane bearer authenticate as the bot bridge.

## Capability boundary

`CapabilityTokenIssuer` signs and verifies bounded HMAC grants. Resource-scoped
grants require the caller to present an exact resource; omitting a resource does
not widen a grant. Tokens are rejected before `issuedAt` and at or after
`expiresAt`, use canonical base64url encoding, and have a maximum 15-minute
lifetime. Signed obligation identifiers travel with the grant so a consumer
receives the constraints attached to the original allow decision. A
profile-hash mismatch invalidates the grant immediately.

`AuditedCapabilityBroker` is the runtime entry point:

1. `issue()` appends a redacted `capability.issued` event before returning the
   token.
2. `authorizeUse()` binds the token to the calling attribution (the kept
   `missionId`/`workerRunId` wire slots), then appends `capability.use.allowed`
   or `capability.use.denied` before returning a decision.
3. An allowed grant is consumed once. Consumption is rehydrated from the event
   log after restart, and same-process broker instances serialize use of the
   same grant.
4. If the event sink fails, issuance and authorization fail closed.

Audit events include SHA-256 fingerprints for grant, capability, and resource
and obligation identifiers plus trusted caller correlation and expiry. Caller-controlled
strings are never copied into event data, so a malicious resource cannot smuggle
a signed token, nonce, or provider credential into the log. `CapabilityAuditSink`
is a minimal append/read shape the host process satisfies with its own event log.
