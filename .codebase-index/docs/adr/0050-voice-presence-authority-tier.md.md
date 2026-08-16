# docs/adr/0050-voice-presence-authority-tier.md

Summoning Clankie into a call is a different
consequence than starting a mission, so voice
presence gets its own authority tier:
`DISCORD_VOICE_JOIN_POLICY` (`ambient` default |
`guild_members`), separate from the ambient
command binding.

Read when adding any new principal class — this
ADR is the cited precedent (a named,
deny-by-default policy, reachable only by writing
the open value exactly). `guild_members` widens
who may start a call and nothing else; the guild
allowlist is always checked first; consent stays
per-microphone. Also adds
`DISCORD_AMBIENT_USER_IDS` for roleless
single-operator setups.
