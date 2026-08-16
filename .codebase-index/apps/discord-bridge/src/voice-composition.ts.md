# apps/discord-bridge/src/voice-composition.ts

Side-effect-free realtime voice composition shared by the bridge startup and offline tests.

- `parseVoiceRealtimeEnv()` validates model, voice, TTS provider, token retention, lifetime/floor/idle bounds and rejects retired knobs.
- `createVoiceRealtimePorts()` builds dormant transcription plus engaged conversation, optionally routing text output through ElevenLabs.
- `createVoiceBriefingProvider()` and `createVoiceLookAtScreenProvider()` map live service reads into the media session.
- `VoiceIdleAutoLeave` arms on join, refreshes on conversational evidence, and leaves a metered idle room.
- Receipt/latency and join/consent/status renderers keep evidence content-free and disclosure accurate for live-session residency and any second speech vendor.
