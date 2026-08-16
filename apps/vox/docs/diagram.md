# ClankVox Diagram

This is the media-plane map for how `clankvox` fits under Clankie. ClankVox is
Clankie's presence plane: the native media plane for voice and Go Live. Discord
is the only platform it targets today, and the roles below are its Discord
transport.

```mermaid
flowchart TB
  user[People in media sessions]
  surfaces[Platform media surfaces]
  discord[Discord voice and stream servers]
  clankie[Clankie Node runtime]
  ipc[stdin JSON lines<br/>stdout framed IPC]
  vox[clankvox Rust media plane]
  family[transport implementations]
  voice[Discord voice role]
  watch[Discord stream_watch role]
  publish[Discord stream_publish role]
  crypto[transport crypto]
  audio[codecs, PCM, RTP audio]
  video[codecs, RTP video]

  user <--> surfaces
  surfaces <--> discord
  clankie <--> ipc
  ipc <--> vox
  vox --> family
  family --> voice
  family --> watch
  family --> publish
  voice --> crypto
  watch --> crypto
  publish --> crypto
  crypto --> audio
  crypto --> video
  audio <--> discord
  video <--> discord
```

## Ownership Split

- Clankie owns prompts, settings, platform gateway control, tools, and product
  behavior.
- `clankvox` owns native media sockets, UDP/RTP, codec framing, transport
  encryption, audio capture, playback pacing, and platform media telemetry.
- The Discord transport adds Discord voice/stream sockets, DAVE, and native Go
  Live watch/publish roles.
- IPC is the boundary. Stdin accepts JSON lines, stdout emits framed IPC
  messages, and stderr is transport logging.

## Discord Runtime Roles

- `voice`: the anchor voice connection for capture and playback.
- `stream_watch`: inbound Go Live receive.
- `stream_publish`: outbound Go Live send.

For the written model, see [Architecture](./architecture.md), [Audio Pipeline](./audio-pipeline.md), and [Go Live](./go-live.md).
