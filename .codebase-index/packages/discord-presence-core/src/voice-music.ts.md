# packages/discord-presence-core/src/voice-music.ts

Shared YouTube DJ surface for the active Discord
mouth. `VoiceMusicQueue` owns one current track,
a 32-track queue, pause state, two-minute
per-speaker numbered search picks, duck/unduck
around speech, and exactly one audio or video
sink per track.

Exports:

- Queue/transport contracts and
  `VoiceMusicQueue` for play, queue, skip, pause,
  resume, stop, now-playing, search, and pick.
- `applyMusicControl`,
  `parseMusicControlPath`, and
  `tryHandleMusicControlRequest` for the shared
  `/music/*` loopback API.
- `searchYouTube` / `parseYtDlpSearchJson` for a
  capped, 15-second `yt-dlp` search.
- `createYoutubeAudioSink` for the
  `yt-dlp`→`ffmpeg`→Discord `AudioPlayer` PCM
  pipeline, including seeked restart after
  speech ducking.

Only HTTP(S) YouTube hosts are admitted. Trace
events carry ids, operations, counts, component
outcomes, and fixed codes—never search queries,
URLs, titles, or audio.
