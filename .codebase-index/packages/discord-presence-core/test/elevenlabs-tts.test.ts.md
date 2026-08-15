# packages/discord-presence-core/test/elevenlabs-tts.test.ts

TTS boundary suite over a fake socket. Covers:
connecting to the multi-stream endpoint with the
pinned pcm_24000 format and the key in headers
only; WSS-or-loopback enforcement and the
charset-constrained path-embedded voice id;
context open handshake with voice settings;
verbatim append/flush/close framing; text-append
and open-context bounds; surfacing decoded
context audio and completion while dropping late
audio for closed contexts (the barge-in
property); carrying odd bytes across chunk
boundaries so surfaced PCM is always whole s16le
samples; failing closed past the per-context
audio byte cap; sanitized server error codes; and
the lifetime cap plus idempotent close_socket.
