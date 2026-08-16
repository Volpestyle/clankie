# apps/discord-bridge/src/voice-readiness.ts

inspectDiscordVoiceReadiness: fail-closed
readiness for official-bot DAVE group voice, plus
a content-free echo of the realtime configuration
(models, TTS provider, truncation scalars).

Beyond the text-path checks it validates the
CLANKIE_VOICE_* environment exactly as startup
does, the brokered openai (and, when the external
voice is configured, elevenlabs) credentials,
native @discordjs/opus loadability, the service's
voice-briefing endpoint with zero consented ids,
and the live wake-transition probe.

probeVoiceWakeTransition exercises
dormant→engaged for real: opens a transcription
session, then — listener still connected, exactly
like a wake — a conversation session that must
produce a response to one text item (text
modality under ElevenLabs; the TTS socket itself
is deliberately not probed). Audio deltas are
zeroed on arrival; every stage is capped by a
timeout. Tests inject a fake probe; the CLI path
builds the live one.
