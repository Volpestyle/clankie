# apps/discord-bridge/src/voice-composition.ts

Import-light, side-effect-free composition for the
two-tier realtime voice (ADR 0057) so the wiring
is testable without index.ts. Five sections:

1. parseVoiceRealtimeEnv — validates every
   CLANKIE_VOICE_* knob (models, TTS provider,
   ElevenLabs voice id pairing, truncation ratio,
   idle auto-leave bounds, decay window); retired
   cascade env names fail loudly.
2. createVoiceRealtimePorts — DiscordVoiceRealtime
   ports over the runtime sessions; with the
   `elevenlabs` provider (ADR 0070) the engaged
   tier becomes text-modality realtime ears paired
   with an ElevenLabs TTS mouth behind the same
   port. createVoiceBriefingProvider maps briefing
   requests onto the service endpoint (ids only).
3. createBoundedChatVerdict /
   createVoiceVolitionDecider — one temperature-0,
   5-token, hard-timeout chat call that fails
   closed and never logs room text; volition
   answers strictly yes/no.
4. VoiceIdleAutoLeave — watches the evidence
   stream; joins arm, utterance/response/floor
   re-arm, left disarms; leaves the metered
   channel after the idle window.
5. Receipt projection (voiceEvidenceReceiptType/
   Data), describeVoiceResponse (per-turn latency
   line split by wake class, trigger, and handoff
   path), and the disclosure renderers for join,
   consent, and voice-status — wording states
   live-session residency and, under ElevenLabs,
   the second vendor; delivery is ephemeral-only
   by owner decision.
