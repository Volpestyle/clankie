# packages/discord-presence-core/src/external-voice.ts

`openExternalVoiceConversation` (ADR 0070) pairs
a text-modality realtime session (ears + brain)
with streaming ElevenLabs TTS (mouth) behind the
same `VoiceConversationPort` as native realtime
audio. It forwards audio, text, tool results,
instruction updates, and bounded screen-image
items without exposing the mouth choice to
`voice-session`.

It solves three ordering failures: holds
`response.done` until TTS drains (30-second
bound), converts barge-in into TTS context close
plus a bounded interruption marker, and releases
in-flight work/reopens lazily when the mouth dies.
A serialized operation chain preserves
open→append→flush order; late audio for dropped
items is discarded.

`splitSpeakableUnits` turns streamed text into
complete decimal/abbreviation-safe phrases,
forcing a word-boundary split at 200 characters
instead of synthesizing token-by-token.
