# Discord media and visual surfaces

Clankie has three distinct ways to show or inspect moving pictures and one
shared native voice path. They use different Discord capabilities and should
not be described as one generic stream.

| Surface                                     | Active body                   | Direction                   | What viewers get                                          |
| ------------------------------------------- | ----------------------------- | --------------------------- | --------------------------------------------------------- |
| Ordinary Discord voice and YouTube music    | Bot or personal-lab user body | Clankie to voice channel    | Audible voice/music through Vox's primary voice role      |
| Embedded Activity at `activity.clankie.bot` | Official bot                  | Clankie to Activity viewers | Live GBA frames and synchronized cartridge sound          |
| Go Live publish                             | Personal-lab user body only   | Clankie to Discord viewers  | H264 video through Vox; currently no source audio         |
| Screen-share watch                          | Personal-lab user body only   | Discord sharer to Clankie   | Up to four chronological JPEG samples for `observe_share` |

The canonical current media diagram is in
[ADR 0128](adr/0128-vox-is-the-sole-discord-media-owner.md). The old
`discord-media.jpg` export is a historical pre-migration snapshot.

## YouTube music

There is no `/music` command. Ask Clankie in ordinary TUI/Discord text or voice,
or paste a YouTube URL. Text requests use the captain's `youtube_search` and
`music_*` tools; voice exposes the same controls locally on its realtime
session.

Supported inputs are:

- a YouTube search query;
- a 1-based result number from that requester's latest search, valid for two
  minutes; or
- an HTTP(S) URL on `youtube.com`, `youtu.be`, `music.youtube.com`, or
  `m.youtube.com`.

Search returns at most five results. A playlist URL does not enqueue the whole
playlist because playback uses `--no-playlist`. Spotify, SoundCloud, local files,
and arbitrary media URLs are rejected by the product music queue.

`music_play` replaces the current track and clears the queue. `music_queue`
starts immediately when idle or appends up to 32 waiting tracks. Skip advances;
stop clears the current track and queue; pause/resume are idempotent. The queue
is process-global for the active body, not per guild or requester.

The active body is the audible path. It must already be in voice and requires
`yt-dlp`, FFmpeg, the body and voice credentials documented in
[credentials.md](credentials.md), and the selected realtime provider credential
for spoken conversation. Vox decodes music to PCM and sends it through the same
primary voice role as TTS; no YouTube API key or YouTube account credential is
used. TTS ducks the current native music stream and restores it when speech
settles. Music controls affect only the track the music sink owns, and play
narration is held while a requested track is still starting.

Playback first asks YouTube's token-free embedded client for a direct audio-only
format. If that fails before the first PCM frame, the one retry uses a
low-bandwidth HLS format with audio. It never falls back to the direct format on
that second attempt. Receipts classify detected downloader failures as
`http_403` or `format_unavailable` and label lifecycle events
`attempt_1_direct` or `attempt_2_hls`, without retaining the URL, selector, or
query.

The bot and lab bodies use the same bounded `DiscordVoiceSession.music` queue.
Native end-of-track events advance that queue in either body. Music does not
route through Go Live; explicit Go Live start/stop remains an independent,
video-only surface.

## Embedded Activity

The official bot launches the supported watch-me-play Activity with
`/clankie watch` or the captain's `discord_watch_start` tool. The Activity viewer
holds no Discord token, emulator core, input channel, or machine authority. It
renders the latest producer frame and overlay, plays live cartridge sound after
the viewer presses **Enable sound** at whatever level the volume slider is set
to, and shows a present-tense work state so a
still-visible prior thought never makes a live model decision look stuck.

Only Clankie's own local or hosted play path publishes gameplay media to this
surface. GBA MCP is a private contract sandbox: its observed PNG may return to
its stdio caller, but it has no Activity producer or play-voice connection and
cannot interrupt or impersonate a live Clankie playthrough
([ADR 0129](adr/0129-each-player-owns-a-body.md)).

The local process has two listeners:

| Listener          | Default          | Access                                                 |
| ----------------- | ---------------- | ------------------------------------------------------ |
| Viewer            | `127.0.0.1:4320` | Public through the Cloudflare tunnel and Discord proxy |
| Producer/snapshot | `127.0.0.1:4322` | Loopback plus `clankie_activity_producer` bearer       |

The production hostname is `https://activity.clankie.bot`. The Discord
Developer Portal Activity URL Mapping and Entry Point must target that HTTPS
origin, while `~/.cloudflared/config.yml` maps only the viewer hostname to
`http://127.0.0.1:4320`. Never expose port 4322. The public viewer is
unauthenticated: anyone who can reach the hostname can see the current retained
frame.

Use `clankie restart activity`, `clankie restart tunnel`, and `clankie health`
for the launcher-owned services. A public `502` means the Cloudflare edge is
reachable but the local Activity origin is down. See the
[Activity operating guide](../apps/discord-activity/README.md) for first-time
tunnel setup and frame bounds.

## Go Live publish

Only the active personal-lab user body can Go Live. The same
`discord_watch_start` captain tool that launches an Activity on the bot body maps
to Go Live on the lab body. The process joins the allowlisted voice channel,
sends Discord OP18/OP22, passes Discord-issued stream credentials to Vox, and
publishes either:

- an allowed URL through `yt-dlp`/FFmpeg; or
- changed PNG snapshots from the private Activity listener.

Activity-backed Go Live depends on the local Activity process and producer
frame, but not on the public tunnel. Vox currently emits 1280x720 H264 video at
30 fps and strips source audio. A successful control request means publication
was accepted. `discord.stream.publish_started` is emitted only after Discord
accepts OP18 and OP22, the `stream_publish` transport is ready, that role has
positive DAVE, and Vox emits `stream_publish_media_started` for the first
accepted H264 access unit of the current connection/source generations.

## Watching another share

Only the active personal-lab user body can receive someone else's Go Live
video. There is no manual start command. When an admitted non-self share appears,
the body watches one stream, sends Discord OP20, and gives the stream-server
credentials to Vox. The integrated product path decodes H264 frames and samples
one JPEG per second. The service retains up to four samples oldest-to-newest;
raw video never enters the semantic event log.

After a real share, verify with:

```bash
pnpm --filter @clankie/discord-user-session watch-live-proof
# or wait up to two minutes for the share:
pnpm --filter @clankie/discord-user-session watch-live-proof -- --wait=120
```

That proof requires the user body to be ready, a watch transport with
`decoder=ready`, and a decoded still from the same user. Watch and publish are
separate roles and require separate proofs. The official bot can report that
someone is sharing but cannot receive the pixels.

## Readiness and ownership proof

These facts are deliberately not aliases:

- `process_ready` carries the explicit IPC protocol version. The client accepts
  no commands until it exactly matches `VOX_IPC_PROTOCOL_VERSION`; it still does
  not mean any Discord media role is connected.
- `transport_state=ready` is scoped to `voice`, `stream_watch`, or
  `stream_publish`; it cannot prove another role.
- positive `dave_state=ready` is separate negotiated-encryption evidence. For
  voice, it also carries the current `connectionId`; a protocol version greater
  than zero is required before `joined`.
- `tts_playback_state=buffered` means PCM is queued, `started` means the first
  audible TTS frame was successfully sent through the voice transport, and
  `drained` means `finish_tts_playback` was received and the PCM, held partial
  tail, and trailing output frames have all crossed the sender.
- `discord.voice.left` qualifies as a clean leave only when the account gateway
  confirms detachment and the receipt records `gatewayConfirmed: true` and
  `mediaOwner: vox`.
- fresh app readiness evidence records `mediaOwner: vox`; a proof from before
  the migration is not accepted.
- a clean primary-voice leave preserves active watch/publish roles, while body
  shutdown closes all roles and the single child. A text-only official-bot
  process has `mediaOwner: none` and spawns no child. Process inspection must
  show no duplicate Discord media owner.

Publish has its own operational proof and receipt log:

```bash
pnpm --filter @clankie/discord-user-session publish-live-proof
# or wait up to two minutes for first media:
pnpm --filter @clankie/discord-user-session publish-live-proof -- --wait=120
```

Both user-session proof modes read
`${XDG_STATE_HOME:-~/.local/state}/clankie/discord-user-session-receipts.jsonl`
unless `DISCORD_USER_SESSION_RECEIPT_PATH` overrides it. They do not read the
official-bot `discord-live-receipts.jsonl`.

Discord bot accounts cannot receive another member's Go Live pixels or publish
Go Live. Those remain user-body capabilities because of platform limits, not
duplicate or abandoned media code.

The [user-session guide](../apps/discord-user-session/README.md) owns account
risk and setup. The [Vox Go Live guide](../apps/vox/docs/go-live.md) owns native
transport mechanics. [Credential identities](credentials.md) explains why the
bot and user tokens never share a process.
