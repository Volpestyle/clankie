# apps/vox/src/voice_conn/ws_ops.rs

Owns post-handshake WebSocket read/write and heartbeat loops. Text handling covers heartbeat ACK, speaking, OP12/18 video-state or legacy disconnect classification, OP13 disconnect, OP14 codec/session updates, and DAVE OP21/22/24; binary frames carry a two-byte sequence plus DAVE OP25/27/29/30/31. Unknown opcodes are logged, malformed payloads are ignored, send/read failures emit one disconnect event, and heartbeat intervals clamp to 1–120 seconds; there is no dedicated reconnect or invalid-session opcode branch here.
