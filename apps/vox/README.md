# Vox

Vox is Clankie's **presence plane**: the dedicated native media plane that
puts Clankie where the humans already are. Today that means Discord: voice
(Opus, E2EE via DAVE, real 20ms send pacing) and Go Live streaming and screen
share — so you can talk to your swarm lead in a voice channel while it
screen-shares its work. It is the layer Clankie delegates to whenever presence
needs realtime sockets, codec work, packet timing, encryption, or low-level
media telemetry that the Node brain is too slow and unequipped to run.

![Vox native media architecture](../../docs/diagrams/vox-architecture.jpg)

[Editable Turbopuffer tldraw source](../../docs/diagrams/vox-architecture.tldraw)

Discord is the only platform ClankVox targets today, and this package
documents that Discord transport. Another platform's media transport would live
at this same layer, behind the same invariant.

**The invariant: ClankVox stays deterministic; Clankie applies policy.** Clankie
stays agentic: prompts, settings, gateway control, Realtime sessions, tools, Pi
delegation, and product behavior. ClankVox stays deterministic: media transport
mechanics, RTP/RTCP, codecs, transport encryption, playback pacing, media
capture/publish, and IPC. For Discord that means Opus, DAVE, H264/VP8, music
PCM, and Go Live watch/publish.

## 1. What ClankVox Handles

Clankie delegates the realtime media transport work that should not live in the
Node runtime. For Discord, that means ClankVox owns:

- Discord voice and stream-server sockets, UDP/RTP send and receive
- codec advertisement, packet framing, Opus encode/decode, PCM normalization
- DAVE session lifecycle and encryption/decryption
- joining a voice channel and emitting inbound audio/video capture events
- streaming assistant speech or music back with correct outbound playback cadence
- native Go Live watch (inbound frames for screen-watch workflows) and narrow
  H264-backed self-publish when Clankie orchestrates the source
- keeping transport truth local — voice, screen, and playback telemetry reported
  to Clankie's floor-control policy instead of guessed from Node-side queued bytes

ClankVox reports transport truth and leaves the product decisions to Clankie.

## 2. Mental Model

The canonical media-plane map is [docs/diagram.md](./docs/diagram.md).

Clankie owns product policy and ClankVox owns deterministic media mechanics; they
meet at the stdin/stdout IPC boundary. The Discord transport exposes three roles
(`voice`, `stream_watch`, and `stream_publish`) because Go Live is a separate
stream-server leg, not an extra field on the normal voice socket.

## Runtime Shape

The entrypoint is [src/main.rs](./src/main.rs). At startup ClankVox:

1. installs rustls crypto
2. starts a single IPC writer and reader
3. creates shared `AppState`
4. enters one `tokio::select!` loop
5. multiplexes IPC, voice events, music events, reconnect timers, and the 20ms
   send tick

Most behavior is split across supervisor-style modules:

- [src/app_state.rs](./src/app_state.rs): shared state and transport slots
- [src/connection_supervisor.rs](./src/connection_supervisor.rs): connect,
  disconnect, and reconnect control
- [src/capture_supervisor.rs](./src/capture_supervisor.rs): inbound audio/video
  events and subscriptions
- [src/playback_supervisor.rs](./src/playback_supervisor.rs): TTS/music
  playback and periodic send tick
- [src/stream_publish.rs](./src/stream_publish.rs): outbound Go Live sender
  pipeline
- [src/voice_conn.rs](./src/voice_conn.rs): root of the Discord voice/stream
  transport module tree
- [src/ipc.rs](./src/ipc.rs): Clankie <-> Rust message contracts

## What To Read

- [Architecture](./docs/architecture.md): process model, ownership boundaries,
  transport roles, IPC, and module map.
- [Diagram](./docs/diagram.md): docs-UI-friendly media-plane map.
- [Audio Pipeline](./docs/audio-pipeline.md): capture, TTS, music, playback
  pacing, and telemetry.
- [Go Live](./docs/go-live.md): native screen watch, native self publish,
  stream discovery, sender/receiver flows.

The product integration lives in
[`../discord-user-session`](../discord-user-session), which imports the
separately Apache-licensed process client from `@clankie/vox-client`.

## Build And Test

ClankVox is Unix-only and requires Rust 1.85+ and CMake to build. URL/video
playback also uses the host's FFmpeg and yt-dlp installations. H264 publishing
requires an FFmpeg build with the libx264 encoder; `pnpm doctor` reports the
FFmpeg and yt-dlp executables but does not check for libx264 encoder support.

```bash
pnpm --filter @clankie/vox typecheck
pnpm --filter @clankie/vox test
pnpm --filter @clankie/vox build
```

Plain `cargo` commands work: [.cargo/config.toml](./.cargo/config.toml) pins
the build environment (`OPUS_STATIC=1`, `OPUS_NO_PKG=1`, and
`CMAKE_POLICY_VERSION_MINIMUM=3.5`: `audiopus_sys` builds bundled libopus
through cmake, and cmake >= 4 refuses its vendored `cmake_minimum_required`
without that floor).

The client resolves `target/release/clankvox`, then
`target/debug/clankvox`, then the compatibility installation at
`~/.clankie/bin/clankvox`. `CLANKIE_VOX_BIN` explicitly selects another build.

## License boundary

This package is `AGPL-3.0-or-later`; see [LICENSE](./LICENSE) and
[PROVENANCE.md](./PROVENANCE.md). The surrounding Clankie monorepo remains
Apache-2.0. The process and typed IPC boundary keep the differently licensed
media implementation explicit rather than silently relicensing it.

## Discord Boundaries

- ClankVox is Clankie's native voice/media transport plane; Discord voice and Go
  Live are the transports it implements, and Discord is the only platform it
  targets today.
- Inbound native screen watch is integrated end to end through `stream_watch`.
- Outbound publish exists and is intentionally narrow: YouTube-backed
  music/video URLs plus browser-session PNG frames, H264 sender transport, and
  Clankie-owned source orchestration.
- Native Go Live behavior depends on Discord user-token/selfbot flows.
- Go Live DAVE video decrypt and raw UDP keyframe feedback remain the important
  transport constraints; see [Go Live](./docs/go-live.md) for detail.
