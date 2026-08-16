# packages/discord-presence-core/src/voice-audio.ts

Memory-only PCM conversion helpers between
Discord's 48 kHz stereo s16le and the model
formats — no subprocesses, no files.

- `discordPcmToSpeechPcm` — 48 kHz stereo →
  16 kHz mono (downmix + take-every-third-frame).
- `discordPcmToRealtimePcm` — 48 kHz stereo →
  24 kHz mono for the realtime input buffer
  (downmix, average adjacent frame pairs).
- `openAiPcmToDiscordPcm` — 24 kHz mono → 48 kHz
  stereo via linear interpolation, for
  @discordjs/voice raw playback.
- `encodeMonoPcmWav` — canonical PCM WAV wrapper
  (whisper.cpp-compatible).
- `pcmDurationMs` and the sample-rate/channel
  constants (`SPEECH_SAMPLE_RATE`, etc.).

Converters throw on partial s16le samples and
invalid formats.
