# Authenticated remote Discord ingress

`POST /v1/discord/ingress` accepts a connection's sealed, fleet-permitted text
turn or connection-owned voice callback. It is not an operator bearer API. The public gateway forwards this route's
own encrypted envelope; neither message text nor the answer is plaintext there.
The managed body's broker owns a P-256 ingress key, registered through the signed
`/fleet/v1/body/discord-key` call at boot. Failed registration retries without
preventing the rest of the body from starting. Unmanaged bodies do not enable
this hosted ingress automatically.

The contracts are exported from `@clankie/protocol/discord-ingress` and the Node
cryptographic client from `@clankie/protocol/discord-ingress-crypto`.

1. The trusted connection creates a strict `DiscordIngressEvent`: tenant and
   installation, delivery/message/channel/actor ids, addressed kind, verified
   owner flag, bounded content/images, original timestamp and at most five-minute
   expiry. An end user's message cannot choose identity or authority.
2. `prepareDiscordIngress(event, registeredPublicKey)` creates an ephemeral P-256
   response recipient and nonce. Its digest is SHA-256/base64url of UTF-8
   `JSON.stringify(["clankie-discord-ingress-v1", parsedEvent, ephemeralPublicKey,
nonce])`. Binding the recipient prevents a gateway from re-encrypting known
   text under its own key to steal a private answer.
3. The connection gets a 60-second fleet permit for that digest, tenant and
   installation. Its Ed25519 header/claims have distinct `clankie-discord` type,
   `clankie-body` audience, and the body's existing fleet trust roots.
4. `prepared.seal(permit)` creates the HTTP envelope. P-256 ECDH and HKDF-SHA256
   derive an AES-256-GCM key. The salt is the 16-byte nonce; info is the domain,
   tenant and installation joined by newlines. Each ciphertext is IV(12), data,
   tag(16), base64url. AAD appends request/response and the exact permit. Call
   `prepared.destroy()` when done.
5. The body verifies before admission, durably records the delivery, starts the
   existing Discord captain flow, and returns a sealed result. Poll with a fresh
   permit/envelope for the same event until reply/silent/failed; pending does not
   start another turn. The verified owner gets the existing machine-authority
   session separation; other participants keep their existing local grants.

On a crash after admission, an uncertain pending turn becomes `interrupted`.
It is not automatically repeated: repeating a shell side effect is worse than
asking the customer to retry explicitly. A different event under an existing
delivery id is a conflict. Input errors expose only codes. Admission/result
files are private service state, not telemetry; they contain no Discord token.

The hosted edge, OAuth install UI, tenant routing and wake/allowance policy live
in the private operations repository. The official shared bot token never goes
into this service or a tenant's credential broker.

`kind: "message"` is unaddressed guild chat admitted by the owner's wake
trigger (`discord.wakeTrigger`: `mention`, `name` or `any`; VUH-1765; `addressed`
is the earlier spelling of `mention`, still accepted). Any
event except voice may carry `context`: at most 20 buffered channel messages
before it, oldest first, which the body passes to the captain as the turn's
context messages. Context is never a trigger. Default remote text still
requires explicit addressing; channels opt in to buffering separately
(`discord.ambientChannelIds`).

### Self-hosted official bot

A self-hosted machine signed in with its Clankie account can receive the same
envelopes (VUH-1766). With `discord.officialBotEnabled`, the service keeps a
P-256 ingress key in its credential broker and registers it at
`POST /fleet/v1/self-hosted/discord/register` with the account bearer. The
fleet answers with the route id the permits name and its public Ed25519 permit
keys. The edge then delivers through the public gateway to the machine's
account-derived host. Until registration succeeds, the route answers 503, and
while the official bot is off it answers 404. `GET`/`POST /v1/discord/official`
reports and changes this in the running service, without a restart
([CLI and route contract](cli.md#discord-official-statusonoff)).
The edge's `owner` flag grants nothing on this route: the machine's own Discord
settings decide authority, exactly as for a bring-your-own bot. Contracts are in
`@clankie/protocol/official-discord`.

Voice callbacks use `kind: "voice"` and one strict `voice.action`: `briefing`,
`handoff`, or `self_tool`. Briefing and the three existing voice self-tools use
the service's existing voice routes; they grant no general captain or operator
bearer. Handoffs require `voice_event` with the same guild, channel and actor as
the sealed event and the bot transport. The body supplies the hosted identity,
verified owner proof and live source fence before entering the existing captain
flow. Approval prompts remain on the authenticated operator surface.

Callbacks and replies use the same recipient-bound encryption, durable admission,
retry and restart behavior as text. Call audio and provider credentials belong
to the trusted connection; this callback contract never transports a shared bot
token. `state: "voice"` carries the bounded operation result inside the sealed
reply. Hosting, charging and rollout records remain in the private operations
repository.
