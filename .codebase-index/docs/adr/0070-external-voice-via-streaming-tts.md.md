# docs/adr/0070-external-voice-via-streaming-tts.md

The mouth becomes swappable: with an external
voice configured, the realtime session runs
text-only output and its deltas stream through an
ElevenLabs multi-context TTS WebSocket into the
unchanged playback path. Same port
(`VoiceConversationPort`); the media owner cannot
tell the difference.

Read for the three ordering problems the pairing
glue owns (hold `response.done` until synthesis
drains; barge-in closes the TTS context instead
of truncating; the mouth can die independently)
and the `auto_mode` contract: deltas must be
accumulated into sentence/clause units — relaying
raw tokens makes every word its own utterance.
Config is settings-first (`/voice` wizard); the
`elevenlabs` key is broker-only; room audio never
reaches ElevenLabs and the disclosures say so.
