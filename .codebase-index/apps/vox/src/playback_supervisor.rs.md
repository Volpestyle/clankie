# apps/vox/src/playback_supervisor.rs

Applies TTS and music commands, advances the pending-music-start/stop state machines, drains media queues, and emits playback/buffer/transport telemetry. `on_audio_tick()` mixes and DAVE-encrypts Opus, sends one paced RTP frame, and dispatches bounded pending Go Live frames without monopolizing the loop.
