# packages/discord-presence-core/src

Transport-neutral Discord behavior shared by both gateway apps. The public root composes semantic presence, bounded text/voice, realtime and external TTS, music/control, common REST encoding, and content-free evidence helpers.

- `captain-action-control.ts` — authenticated semantic action control handler.
- `discord-rest.ts` — shared reaction-path encoding.
- `elevenlabs-tts.ts` — streaming external TTS session.
- `external-voice.ts` — text-realtime plus TTS composition.
- `index.ts` — package exports.
- `presence-action-advertiser.ts` — live action catalog and execution fence.
- `presence-session.ts` — lifecycle publication state machine.
- `realtime-session.ts` — bounded OpenAI realtime transports.
- `receipt-store.ts` — private content-free JSONL receipts.
- `text-ingress.ts` — allowlisted Discord message to captain turn.
- `voice-address.ts` — spoken name/address matching.
- `voice-audio.ts` — PCM transforms and WAV encoding.
- `voice-composition.ts` — shared config, providers, idle leave, and evidence projection.
- `voice-consent.ts` — per-session participant consent.
- `voice-control.ts` — local join/leave control handler.
- `voice-floor.ts` — group floor and volition policy.
- `voice-ingress.ts` — bounded captain handoff.
- `voice-music.ts` — YouTube search, queue, and playback controls.
- `voice-session.ts` — consented capture, transcription, response, and playback owner.
