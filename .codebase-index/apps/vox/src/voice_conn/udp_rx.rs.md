# apps/vox/src/voice_conn/udp_rx.rs

Runs the inbound UDP loop for audio, video, and muxed RTCP filtering. It applies transport AEAD, resolves SSRC/user mappings, performs packet-level or frame-level DAVE decrypt, tries alternate RTP-extension candidates, depacketizes H264/VP8, and emits bounded `VoiceEvent`s with loss/decrypt telemetry.
