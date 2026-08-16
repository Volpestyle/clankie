# apps/clankie/src/discord-voice-presence.ts

`createDiscordVoicePresenceClient()` forwards captain-requested voice join/leave intents to the active Discord body. Only host-stamped guild and actor identity cross the loopback boundary; the body resolves the live channel and owns the authority decision.
