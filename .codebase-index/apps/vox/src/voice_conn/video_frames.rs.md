# apps/vox/src/voice_conn/video_frames.rs

Maintains codec-specific depacketizers per SSRC and produces primary/alternate frame candidates from RTP payloads. A bounded fallback buffer records distinct packets and replays them only when timestamp/sequence continuity makes an alternate extension interpretation viable.
