# apps/discord-bridge/src/presence-runtime-module.ts

The trusted module the clankie service loads via
CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE.
createDiscordPresenceRuntime hard-errors on token
env vars, then wraps DiscordBotPresenceRuntime so
every execute() first issues a
`discord.presence.act` capability grant from
DiscordBotCredentialProvider (guild/channel
allowlists from DISCORD_PRESENCE_*_IDS) and
resolves the bot token per action from the
broker.

Capability scope falls back from the legacy
missionId wire slot to
`discord-presence:<sessionId>`. Also wires the
filesystem attachment resolver
(CLANKIE_DISCORD_ATTACHMENT_ROOT) and the
activity surface map — only gba_emulator, from
DISCORD_ACTIVITY_APPLICATION_ID_GBA, deny by
default (ADR 0047).
