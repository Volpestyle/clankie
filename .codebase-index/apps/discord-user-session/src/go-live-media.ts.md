# apps/discord-user-session/src/go-live-media.ts

Go Live media publication (ADR 0024 VUH-841).
Discord blocks video from bots, so streaming
needs the GPL-3.0 selfbot stack
(discord.js-selfbot-v13 +
@dank074/discord-video-stream) — deliberately
never declared in this Apache-2.0 workspace and
imported dynamically (specifiers indirected
through variables so bundlers and the dependency
checker never see them) only after an operator
installs it. Absent, loading throws
`discord_presence_go_live_media_unavailable` with
GO_LIVE_INSTALL_HINT verbatim.

createGoLiveMediaPublisher returns
{start, stop, active}: start logs the selfbot in
once, joins voice, prepares an H264 software
encode of the given Readable (defaults 480p/30fps
with bitrate caps), and plays it; a concurrent
second stream is refused, an encoder error clears
`running` so stop is never a stranded no-op, and
stop kills the encoder and leaves voice.
Structural minimal types for the optional
modules keep GPL types out of the tree; tests
inject a fake module pair.
