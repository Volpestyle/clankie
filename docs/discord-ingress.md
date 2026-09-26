# Authenticated remote Discord text

`POST /v1/discord/ingress` accepts a connection's sealed, fleet-permitted text
turn. It is not an operator bearer API. The public gateway forwards this route's
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
into this service or a tenant's credential broker. There is no ambient ingress
kind. Default remote text requires explicit addressing; being awake does not
make Discord supply otherwise restricted Message Content.
