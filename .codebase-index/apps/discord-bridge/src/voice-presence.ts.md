# apps/discord-bridge/src/voice-presence.ts

`executeVoicePresenceIntent()` keeps captain-requested join/leave authority inside the bot body that owns the live gateway and media session. The body resolves the actor's fresh voice state, applies the configured guild/channel policy, manages consent, and returns a typed joined/left/refused outcome.
