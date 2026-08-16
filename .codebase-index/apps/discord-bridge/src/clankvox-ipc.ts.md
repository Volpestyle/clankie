# apps/discord-bridge/src/clankvox-ipc.ts

Reviewed, currently inactive ClankVox schema-1 IPC
compatibility layer (no AGPL ClankVox source is
imported or executed). Defines the NDJSON stdin
command protocol and the framed stdout event
protocol for a voice transport child process.

Zod schemas for commands (session_open, audio as
canonical base64 s16le PCM, session_close,
health_request) and events across four lanes
(control / userAudio / log / health):
process_ready, session_state with DAVE state,
speaking events, transport stats, health
snapshots, logs, errors. Strict everywhere: caps
on line and payload bytes, snowflakes bounded to
u64, lane-vs-type mismatch rejected, log fields
scanned for secret-shaped keys (redaction
contract).

Binary side: ClankVoxFrameDecoder (5-byte
lane+length framing, fail-closed on faults and
truncation at EOF) and decodeClankVoxUserAudio
(18-byte header whose peak/active-sample counters
are recomputed against the PCM and must match).
