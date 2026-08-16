# packages/discord-presence-core/src

- `index.ts` — curated barrel for every module
- `captain-action-control.ts` — validated loopback
  `/captain-action` handler shared by both bodies
- `presence-session.ts` — gateway/voice phase
  lifecycle + act-tool revoke fence
- `presence-action-advertiser.ts` — live catalog
  as an execution fence before the service
- `text-ingress.ts` — gateway messages → bounded
  policy-gated captain turns; images; typing;
  live-window/catch-up attention model
- `voice-address.ts` — phonetic address detection
  over transcripts
- `voice-floor.ts` — pure dormant↔engaged floor
  machine with the volition rate cap
- `realtime-session.ts` — OpenAI Realtime
  boundary: per-speaker transcription + engaged
  conversation tools
- `elevenlabs-tts.ts` — multi-context streaming
  TTS boundary (ADR 0070)
- `external-voice.ts` — text-realtime + TTS pair
  behind one conversation port
- `voice-session.ts` — the media owner: consent,
  per-speaker capture, floor wiring, sight, music,
  playback, barge-in, possessor narration
- `voice-control.ts` — loopback `/voice/join` and
  `/voice/leave` handler
- `voice-music.ts` — YouTube search/queue,
  loopback music controls, and audio sink
- `voice-ingress.ts` — one ask_clankie handoff →
  the discord_voice captain lane
- `voice-consent.ts` — ephemeral session-bound
  consent registry
- `voice-audio.ts` — in-memory PCM conversions
  (48k stereo ↔ 24k/16k mono, WAV)
- `receipt-store.ts` — append-only content-free
  JSONL receipts

Flow: gateway events → text-ingress or
voice-session; each speaker's audio → its own
transcriber → floor machine → conversation tier
(native voice or external-voice pair) → playback;
privileged abilities go through ask_clankie →
voice-ingress → captain, while sight and music
stay local to the call.
