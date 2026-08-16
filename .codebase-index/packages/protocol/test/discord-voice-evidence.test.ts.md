# packages/protocol/test/discord-voice-evidence.test.ts

Voice-evidence suite (ADR 0057): parses every
capture/transcription, floor-decision, model,
realtime-tool, music, response/playback, and
possessor variant. It pins fast-path vs captain-
handoff timing, optional stay/token/session
counters, and narration suppression.

Strictness tests prove transcript/prompt/audio,
music URLs, arbitrary codes, retired timings,
unknown fields, negative/non-finite numbers, and
other free text are unrepresentable.
