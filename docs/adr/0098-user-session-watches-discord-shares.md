# ADR 0098: The lab user body watches Discord shares through ClankVox

Status: accepted (2026-08-15). The native package placement is owned by
[ADR 0100](0100-vox-is-an-owned-native-media-package.md). Current-status
addendum (2026-08-19): [ADR 0128](0128-vox-is-the-sole-discord-media-owner.md)
supersedes the user-body-only media-owner and video-routed music assumptions.
The user body now shares one Vox child across audible primary voice/music,
`stream_watch`, and `stream_publish`; watch/publish remain separate role proofs.
Their operational commands are
`pnpm --filter @clankie/discord-user-session watch-live-proof` and
`pnpm --filter @clankie/discord-user-session publish-live-proof`, both against
the user-session receipt log and both optionally accepting `-- --wait=120`.
The body gating, account-risk, stream admission, and sampled-still decisions
remain in force. The rollout details below are historical where they conflict.

## Context

Discord does not give official bots Go Live video. Clankie already talks in
voice as the bot ([ADR 0045](0045-official-bot-dave-group-voice.md),
[ADR 0057](0057-realtime-voice-with-captain-handoff.md)). Watching someone
else's screen share is the remaining hole [ADR 0024](0024-discord-dual-plane-presence.md)
named VUH-840.

ClankVox v1 exposes `stream_watch`: OP20 credentials in, DAVE +
H264 decode, JPEG stills out. It is AGPL-3.0-or-later. ADR 0100 owns its
mixed-license placement in this otherwise Apache-2.0 repository.

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

**ClankVox is the owned Vox sidecar.** Its AGPL Rust source and package license
live in `apps/vox`; the Apache `@clankie/vox-client` package owns the typed
process boundary. The client resolves the workspace release or debug build,
with the old home install as a compatibility fallback. Go Live DAVE decrypt is
Vox's: per-packet decrypt before depacketize, SSRC remap, and `davey` 0.1.4.

**Stills are sampled, not streamed into realtime.** ClankVox emits one JPEG
per second; the service keeps the latest four in memory and optionally writes
`shares/` as host-minted artifacts. `observe_share` gives the captain those
samples oldest-to-newest for coarse motion. `gpt-realtime` only gets a briefing
line that a share exists.

**The inactive body is down.** That is how the room hears one voice
([ADR 0074](0074-the-room-hears-one-voice.md)). When the lab body is
active it joins unmuted. When the bot is active, watch is unavailable.

**Productization.** `/discord` stores the user token, enablement, allowlists,
the durable opt-in, and `activeBody`. The launcher starts
`@clankie/discord-user-session` only when that body is enabled **and**
active. The owner opt-in, allowlists, and active-body switch remain mandatory.

## Consequences

- `clankie restart` starts the lab body only after settings + opt-in + token
  - `activeBody=user_session`, and stops the official bot.
- Without a built Vox binary, shares are listed and he cannot see the picture.
- Publish (`go_live_start`) joins the voice channel, sends OP18 then OP22
  unpause, connects ClankVox, and plays either an optional `sourceUrl` or
  the live activity PNG snapshot (`GET 127.0.0.1:4322/snapshot`). URL publish
  is currently video-only: the native pipeline strips source audio, and the
  official bot is not running while this body is active. Audible synchronized
  music therefore waits for the user-session voice path to move onto Vox.
- Live evidence is `pnpm --filter @clankie/discord-user-session live-proof`
  against user-session receipts: ready, watch_connected with decoder=ready,
  and one decoded still of that user after the watch. Deterministic tests
  cannot mint those receipts.
