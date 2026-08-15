# packages/discord-presence-core/src/voice-consent.ts

`DiscordVoiceConsentRegistry`: ephemeral,
session-bound consent to being heard, judged
under a `DiscordVoiceConsentPolicy` —
`explicit` (default: only the opt-in command
grants it; restart/leave/channel-move/revocation
remove it; presence is never consent) or
`presence` (being in his active channel is
consent — an owner decision for a private room —
but a spoken "no" always wins and outlives
rejoining).

API: `open(guildId, channelId, invokingUserId?)`
(the slash invoker who saw the disclosure is
auto-opted-in; an asked join passes nobody),
`set` (consent/refuse), `memberChannelChanged`
(leaving the channel drops consent), `permits`
(the per-chunk check), `permitted(guild, channel,
occupants)` — who may actually be heard right
now: the opt-in set under explicit, the room
minus refusers under presence — `close`,
`current`.
