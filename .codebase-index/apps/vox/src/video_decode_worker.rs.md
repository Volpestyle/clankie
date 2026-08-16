# apps/vox/src/video_decode_worker.rs

Runs per-user persistent H264 decode and JPEG encode on one dedicated thread. Its frame lane is bounded to eight jobs and drops the oldest under pressure, its remove/clear control lane is intentionally unbounded and drained before queued frames, and its decoder-reset PLI lane is bounded to 16; every accepted frame advances decoder reference state while the fps gate limits JPEG emission.
