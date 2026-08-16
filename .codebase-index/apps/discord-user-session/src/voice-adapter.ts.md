# apps/discord-user-session/src/voice-adapter.ts

DiscordUserVoiceAdapters: bridges the hand-rolled
user gateway to @discordjs/voice so the one
maintained media stack (RTP/Opus/DAVE, ADR 0045)
works unchanged behind a user session — the voice
websocket authenticates with the
VOICE_SERVER_UPDATE token, not the gateway
credential.

Forwards voice server updates and the session's
own voice-state updates (raw dispatch payloads,
never reconstructions) into per-guild adapter
methods; creatorFor(guildId) yields the adapter
handed to joinVoiceChannel, and destroyAll clears
them at shutdown.
