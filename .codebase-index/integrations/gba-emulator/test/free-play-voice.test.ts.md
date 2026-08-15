# integrations/gba-emulator/test/free-play-voice.test.ts

Tests the voice module: both schema keys stay
required (never `.nullish()` — OpenAI
structured output rejects optional keys),
bounded remarks, `renderVoiceView` content
including the never-spoken cold start, and
`voiceHasSomethingToConsider`'s cost gate.
