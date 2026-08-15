# packages/credential-broker/src/discord-bridge-credential.ts

The four broker-owned bridge-plane bearers:
`clankie_discord_bridge` (bot text),
`clankie_discord_voice_bridge` (bot voice),
`clankie_discord_user_bridge` (user text), and
`clankie_discord_user_voice_bridge` (user voice).
Each gets mint/resolve/ensure functions; the
service mints on first start and the bridge only
resolves, so there is no cross-process mint race.

The token patterns are anchored and mutually
exclusive — `clankie_discord_` is a prefix of
every other bearer, so the bot-plane pattern uses
negative lookaheads to reject the voice and user
forms; otherwise a user-session bearer would
authenticate as the bot bridge and inherit its
lane. The service derives `transportKind` from
which bearer authenticated, never from a request
body.
