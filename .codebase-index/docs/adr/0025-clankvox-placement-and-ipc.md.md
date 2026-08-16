# docs/adr/0025-clankvox-placement-and-ipc.md

Superseded: planned an in-repo Rust voice sidecar
(ClankVox) with versioned NDJSON/binary-framed
IPC for official-bot Discord voice. ADR 0045
chose `@discordjs/voice` instead; no AGPL ClankVox
source was ever imported.

Read only when touching the schema-1 IPC parser
(`clankvox-ipc.ts`), which remains an inactive
compatibility artifact, or for the wire format:
NDJSON commands in, five-byte lane-framed events
out, the 18-byte `user_audio` PCM header, and the
one-session-per-process rule.
