# apps/discord-user-session/src/presence-runtime-module.ts

Trusted service load target for the user-session
transport
(CLANKIE_DISCORD_USER_PRESENCE_RUNTIME_MODULE),
mirroring the bot plane's module contract.
DISCORD_USER_TOKEN in the env is a hard error.

Per action:
DiscordUserSessionCredentialProvider issues a
`discord.presence.act` grant bounded by the
DISCORD_USER_SESSION_* allowlists and re-checked
against the durable opt-in (fetched from the
service by profile hash — the record is
token-free), then resolves the user token and
runs DiscordUserPresenceRuntime.execute.
loadOptInFromControlPlane authenticates with the
brokered user-bridge bearer.
