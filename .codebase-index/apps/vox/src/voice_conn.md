# apps/vox/src/voice_conn

Protocol-specific pieces behind `VoiceConnection`, split so handshake, WebSocket control, UDP receive, video assembly, and outbound packetization can evolve independently. All paths report typed `VoiceEvent`s back to the serialized `AppState` loop.

- `diagnostics.rs` — pure DAVE trailer marker inspection; caller-owned diagnostic rate limits live in UDP receive.
- `handshake.rs` — Hello/Ready/Session Description reads and UDP IP discovery.
- `protocol.rs` — Discord opcode payloads, codec negotiation, and state announcements.
- `tx.rs` — outbound Opus/H264 RTP and protected RTCP feedback.
- `udp_rx.rs` — inbound UDP audio/video decrypt, depacketize, and event emission.
- `video_frames.rs` — per-SSRC codec assembly and alternate-extension fallback buffering.
- `ws_ops.rs` — heartbeat, command writer, typed text/binary opcode handling, DAVE transitions, and disconnect notification.
