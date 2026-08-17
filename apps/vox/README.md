# Vox

Vox is Clankie's native Discord media implementation: realtime sockets, codecs,
packet timing, encryption, capture, playback, screen watch, and Go Live. The
current product rollout uses Vox for the active lab user body's screen-watch and
Go Live paths. Ordinary bot and user-session voice and audible music still use
`@discordjs/voice`; Vox's voice/audio contract is implemented for a separately
evidenced migration ([ADR 0100](../../docs/adr/0100-vox-is-an-owned-native-media-package.md)).

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

For Discord, ClankVox implements:

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

The cross-package/process map is the diagram above. The
[internal transport map](./docs/diagram.md) details Vox modules and roles.

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
[`apps/discord-user-session`](../discord-user-session/README.md), which imports the
separately Apache-licensed process client from `@clankie/vox-client`. The
[Discord media guide](../../docs/discord-media.md) describes the user-visible
Activity, Go Live, share-watch, and music differences.

## Build And Test

ClankVox requires a Unix-like host, Rust 1.88+, and CMake. The build fails
explicitly on non-Unix targets because media subprocess control uses a POSIX
shell and process groups. URL/video playback additionally requires host
`ffmpeg` and `yt-dlp`; H264 publishing requires FFmpeg's `libx264` encoder.
`pnpm doctor` treats Rust and CMake as required development prerequisites and
reports `ffmpeg`/`yt-dlp` as optional feature tools. It does not check the Unix
shell contract or `libx264` encoder availability.

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

This package is `AGPL-3.0-or-later`; see [LICENSE](LICENSE) and
[PROVENANCE.md](PROVENANCE.md). The surrounding Clankie monorepo remains
Apache-2.0. The process and typed IPC boundary keep the differently licensed
media implementation explicit rather than silently relicensing it.

## Discord Boundaries

- ClankVox implements Discord voice and Go Live transport; Discord is the only
  platform it targets today. Current product integration consumes the two Go
  Live roles, not native ordinary voice/music.
- Inbound native screen watch is integrated end to end through `stream_watch`.
- Outbound publish exists and is intentionally narrow: YouTube-backed
  music/video URLs plus browser-session PNG frames, H264 sender transport, and
  Clankie-owned source orchestration.
- Native Go Live behavior depends on Discord user-token/selfbot flows.
- Go Live DAVE video decrypt and raw UDP keyframe feedback remain the important
  transport constraints; see [Go Live](./docs/go-live.md) for detail.
