# packages/discord-presence-core/src/voice-ingress.ts

`DiscordVoiceIngress`: routes one speaker-
attributed transcript (an `ask_clankie` request)
through the durable `discord_voice` captain lane.
Normalizes whitespace, refuses empty transcripts
before any captain call, builds a
`DiscordPresenceChannelTurnRequest` with a
`voice_event` trigger, and maps the result to
`DiscordVoiceTurnOutcome`: settled (spoken
response), declined (captain used the silence
sentinel — say nothing rather than read a marker
aloud), waiting_user (approval-shaped results
become the fixed authenticated-surface sentence,
so ambient voice can never approve privileged
work), or failed with a code.
