# packages/discord-presence-core/test

Fifteen vitest suites covering the shared
Discord boundary:

- `addresses-character.test.ts` — text-plane name
  matching + reply-policy parsing
- `voice-address.test.ts` — phonetic addressing
- `voice-floor.test.ts` — the floor machine under
  an explicit clock
- `voice-audio.test.ts` — PCM conversions
- `voice-consent.test.ts` — both consent policies
- `voice-ingress.test.ts` — captain-lane handoff
- `voice-session.test.ts` — the full media owner
  (largest suite)
- `realtime-session.test.ts` — both realtime
  tiers over a fake socket
- `elevenlabs-tts.test.ts` — the TTS boundary
- `external-voice.test.ts` — the paired-mouth
  port + splitSpeakableUnits
- `presence-session.test.ts` — phase lifecycle,
  fencing, publication retry
- `text-ingress.test.ts` — the text plane end to
  end (second largest)
- `receipt-store.test.ts` — receipt schema and
  file hygiene
- `captain-action-control.test.ts` — validated
  host-stamped loopback actions
- `voice-music.test.ts` — YouTube search/control,
  queue semantics, pipeline and trace hygiene
