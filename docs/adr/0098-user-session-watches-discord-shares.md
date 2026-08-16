# ADR 0098: The lab user body watches Discord shares through ClankVox

Status: accepted (2026-08-15).

## Context

Discord does not give official bots Go Live video. Clankie already talks in
voice as the bot ([ADR 0045](0045-official-bot-dave-group-voice.md),
[ADR 0057](0057-realtime-voice-with-captain-handoff.md)). Watching someone
else's screen share is the remaining hole [ADR 0024](0024-discord-dual-plane-presence.md)
named VUH-840.

ClankVox v1 exposes `stream_watch`: OP20 credentials in, DAVE +
H264 decode, JPEG stills out. It is AGPL-3.0-or-later. This repository is
Apache-2.0, and [ADR 0025](0025-clankvox-placement-and-ipc.md) keeps ClankVox
outside the tree without a recorded license disposition.

The two tokens stay stored. Exactly one body is **active** — the mouth
the launcher starts. [ADR 0048](0048-discord-user-session-transport.md)
owns that switch.

## Decision

**Both tokens stay stored. One body is active.** `discord.activeBody` is
`bot` or `user_session`. The launcher starts only that process. Default is
the official bot. The lab body becomes the mouth — talk, watch, Go Live —
only when it is active.

**Watch lives in `apps/discord-user-session`.** That process owns the raw
user gateway, sends OP20 `STREAM_WATCH`, and talks to ClankVox. The bot
bridge only reports `self_stream` metadata so he can say someone is sharing
even when the lab body is off.

**ClankVox stays an external AGPL sidecar.** This repo holds an Apache-2.0
IPC client (`clankvox-sidecar.ts`). The binary is resolved from
`CLANKVOX_BIN` or `~/.clankie/bin/clankvox`. No Rust source is vendored. Go
Live DAVE decrypt is ClankVox's: per-packet decrypt before depacketize,
SSRC remap, and `davey` 0.1.4. Rebuild and install that binary; this repo
does not vendor the fix.

**Stills are sampled, not streamed into realtime.** ClankVox emits JPEGs;
the service keeps the latest one in memory and optionally writes `shares/`
as a host-minted artifact. `observe_share` is how the captain looks.
`gpt-realtime` only gets a briefing line that a share exists.

**The inactive body is down.** That is how the room hears one voice
([ADR 0074](0074-the-room-hears-one-voice.md)). When the lab body is
active it joins unmuted. When the bot is active, watch is unavailable.

**Productization.** `/discord` stores the user token, enablement, allowlists,
the durable opt-in, and `activeBody`. The launcher starts
`@clankie/discord-user-session` only when that body is enabled **and**
active. High-assurance and team profiles still deny the transport.

## Consequences

- `clankie restart` starts the lab body only after settings + opt-in + token
  - `activeBody=user_session`, and stops the official bot.
- Without `CLANKVOX_BIN`, shares are listed and he cannot see the picture.
- Publish (`go_live_start`) joins the voice channel, sends OP18 then OP22
  unpause, connects ClankVox, and plays either an optional `sourceUrl` or
  the live activity PNG snapshot (`GET 127.0.0.1:4322/snapshot`). Song
  requests go through the captain or voice model (`youtube_search` then
  `music_play` / `music_queue`); the live body is only the queue and
  sink. The lab body Go Lives the URL. The official bot plays audio in
  voice. Speech ducks the current sink.
- Live evidence is `pnpm --filter @clankie/discord-user-session live-proof`
  against user-session receipts: ready, watch_connected with decoder=ready,
  and one decoded still of that user after the watch. Deterministic tests
  cannot mint those receipts.
