# apps/vox/src/music.rs

Owns the yt-dlp/ffmpeg music subprocess, PCM reader thread, redacted stderr tail, lifecycle events, process-group pause/resume/stop, and the `MusicState` active/pending-start fields. Gain envelopes and PCM capacity belong to `AudioSendState` in `audio_pipeline.rs`; playback arbitration advances in `playback_supervisor.rs`, while this module builds direct or yt-dlp-resolved source pipelines and feeds 960-sample PCM chunks to the shared queue.
