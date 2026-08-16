# apps/tui/src/voice-commands.ts

`/voice` — how Clankie sounds in Discord voice (ADR
0070); character, not authority. Two providers: the
OpenAI realtime model's native voice (name stored in
settings) or ElevenLabs streaming TTS (voice id +
model id in settings, API key in the credential
broker under the same `elevenlabs` entry `/auth`
manages).

The wizard finishes the thought: after configuring
ElevenLabs it checks for the key and drops into the
credential editor if missing, so a configured voice
is never left unable to speak. Exports
`validateVendorIdentifier` (public id shape embedded
in URL paths) and `describeVoice` for status.
Changes require a bridge restart.
