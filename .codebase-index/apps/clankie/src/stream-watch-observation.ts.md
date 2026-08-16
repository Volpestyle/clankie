# apps/clankie/src/stream-watch-observation.ts

`DiscordStreamWatchProjection` keeps the latest view of Discord screen shares reported by the bot and user-session bodies. Metadata merges by source, while an optional decoded still is written beneath the attachment root for `observe_share`; raw video never enters the event log.
