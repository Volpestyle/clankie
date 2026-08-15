# apps/discord-bridge/test/fixtures/clankvox-ipc-v1.json

Golden ClankVox IPC schema-1 payloads: the four
commands (session_open, audio, health_request,
session_close), representative events
(process_ready, session_state, speaking_start,
transport_stats), and a hex-encoded user_audio
frame with its 18-byte header. The wire truth the
clankvox-ipc tests encode/decode against — a
change here is a protocol change.
