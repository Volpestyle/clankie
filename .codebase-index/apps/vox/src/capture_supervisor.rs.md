# apps/vox/src/capture_supervisor.rs

Handles capture commands and `VoiceEvent`s for speaking, Opus audio, remote video state, encoded video frames, transport readiness, and disconnects. It maintains subscriptions, detects RTP gaps/reordering, emits bounded IPC capture events, drives H264 decode work, and reasserts keyframe/sink-want requests on its tick.
