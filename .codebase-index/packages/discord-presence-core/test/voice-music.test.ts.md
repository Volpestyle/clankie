# packages/discord-presence-core/test/voice-music.test.ts

Music-control and queue suite over fake sinks,
processes, and loopback HTTP. It covers search →
numbered pick, immediate vs queued playback,
route parsing, YouTube-only URL admission,
`yt-dlp` result parsing, pipeline retry before
first audio, sink rejection, ordered next-track
advance, and pause-safe duck/unduck.

Trace assertions pin correlation ids and
component outcomes while proving queries and
URLs never enter evidence.
