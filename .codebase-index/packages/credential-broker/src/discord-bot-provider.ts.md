# packages/credential-broker/src/discord-bot-provider.ts

`DiscordBotCredentialProvider` — the trusted
boundary for the `discord_bot` token. Callers get
expiring HMAC grants (`discord.presence.act` /
`discord.presence.read`, ≤15 min TTL) scoped to
`discord:guild:*` / `discord:channel:*` resources;
only the trusted transport adapter exchanges a
matching grant for the actual bot token via
`resolveBotToken`.

Allowlist semantics (documented at length inline):
the guild allowlist is the fence; an _empty_
channel allowlist admits any channel inside an
allowed guild — matching what an empty ingress
allowlist means, so his speech reaches exactly as
far as his hearing — while a provider with no
guilds and no channels configured still grants
nothing. Every grant must name at least one
resource, and the stored credential must be a
non-empty `api` key.
