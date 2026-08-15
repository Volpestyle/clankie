# packages/discord-presence-core/src/elevenlabs-tts.ts

`ElevenLabsTtsSession` (ADR 0070): the streaming
external mouth — one multi-context TTS WebSocket
where each context is one utterance. The engaged
realtime session's text deltas stream in; 24 kHz
mono PCM comes back into the same playback path
realtime audio fed. Barge-in is `closeContext`,
stopping paid server-side synthesis mid-sentence.

API: `openContext` (handshake space + voice
settings pinned per utterance), `appendText`
(verbatim; under `auto_mode` the server does no
buffering, so callers must send complete phrases
— `splitSpeakableUnits` upstream holds up that
bargain), `flush`, `closeContext`, `close`.
`openElevenLabsTtsSession` builds the URL
(`.../{voiceId}/multi-stream-input` with
model_id, pinned `pcm_24000` output,
`auto_mode=true`, bounded inactivity timeout).

Discipline mirrors the realtime boundary:
injected transport, WSS-or-loopback, key only in
`xi-api-key` headers, per-context 1-minute audio
byte cap failing closed, per-append text cap, max
4 open contexts, 10 s–4 h lifetime cap, sanitized
error codes. A carry map re-aligns base64 chunk
boundaries to whole s16le samples; audio for a
closed context is dropped (that drop is what
makes closeContext an effective barge-in). PCM
ownership and the zeroing duty transfer to the
caller at the `onAudio` callback.
