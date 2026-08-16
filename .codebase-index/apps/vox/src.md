# apps/vox/src

Rust implementation of the native media process. `main.rs` serializes commands and transport events through `AppState`; supervisors own lifecycle surfaces, while codec, crypto, IPC, and subprocess modules keep heavy work bounded and deterministic.

- `main.rs` — process bootstrap and the central IPC/event/reconnect/audio-tick loop.
- `app_state.rs` — shared transport slots, queues, runtime state, and cumulative telemetry.
- `connection_supervisor.rs` — connect/disconnect for all roles; only primary voice has automatic reconnect scheduling.
- `capture_supervisor.rs` — inbound audio/video subscriptions, sequencing, decode, and capture events.
- `playback_supervisor.rs` — playback commands, music state, paced audio sends, and telemetry.
- `ipc.rs`, `ipc_protocol.rs`, `ipc_router.rs`, `ipc_log_layer.rs` — bounded process contract, routing, and log forwarding.
- `voice_conn.rs`, `voice_conn/` — Discord WebSocket/UDP transport, handshake, receive, and send paths.
- `audio_pipeline.rs`, `music.rs` — PCM conversion/mixing and Opus encoding, plus the music subprocess/player and pending-play state.
- `stream_publish.rs` — H264 URL, visualizer, and browser-frame publish pipelines.
- `dave.rs`, `transport_crypto.rs` — DAVE media E2EE and RTP/RTCP transport AEAD.
- `rtp.rs`, `rtcp.rs`, `h264.rs`, `vp8.rs` — packet and codec framing primitives.
- `video.rs`, `video_state.rs`, `video_decoder.rs`, `video_decode_worker.rs` — in-memory stream/subscription models, Discord wire state, OpenH264/JPEG decode, and worker execution with separately bounded/unbounded lanes.
- `capture.rs`, `media_sink_wants.rs`, `process_unix.rs` — capture records, subscription payloads, and process utilities.

Voice, watch, and publish use distinct connection/DAVE slots because their Discord lifecycles and encryption sessions differ. Blocking decode and ffmpeg work stays off the event loop; each channel's actual capacity and loss policy is module-specific rather than universally bounded.
