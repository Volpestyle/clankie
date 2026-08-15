# apps/tui/test/voice-commands.test.ts

`/voice` through a scripted fake flow with a real
temp-dir `SettingsStore`: provider switching (OpenAI
realtime voice vs ElevenLabs voice/model ids),
vendor-identifier validation, status rendering with
key presence, and the follow-through into the
ElevenLabs credential editor when no key is stored.
