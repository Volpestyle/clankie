# apps/discord-bridge/test/presence-runtime-module.test.ts

Pins the trusted module's credential discipline:
DISCORD_USER_TOKEN and legacy DISCORD_BOT_TOKEN
env vars are hard errors; discord_bot loads only
through a broker file, and the channel allowlist
refuses a write to an unallowed channel
(channel_not_allowed) before any REST happens.
