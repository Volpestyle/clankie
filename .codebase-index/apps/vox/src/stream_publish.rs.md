# apps/vox/src/stream_publish.rs

Implements outbound Go Live source/player state for URL video, audio visualizers, and browser PNG frames. Decoded browser input is capped at 6 MiB; its writer lane holds four frames and drops the oldest, while the raw H264 accumulator aborts above 8 MiB before draining Annex-B access units. The module supervises ffmpeg/yt-dlp process groups and emits timestamped H264 frames/events; Discord RTP transmission remains in `voice_conn/tx.rs`.
