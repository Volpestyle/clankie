# clankvox Architecture

This document is the transport/media-plane view of ClankVox, Clankie's presence
plane: the native media plane that puts Clankie where the humans are.

ClankVox is Clankie's Rust media plane for voice and Go Live. Discord is the only
platform it targets today, and everything below describes that Discord transport:
the native media sockets, codec work, packet timing, encryption, and low-level
telemetry that live below Clankie's Node runtime. The invariant across the
boundary is that ClankVox stays deterministic; Clankie applies policy.

The media-enabled active bot or user-session body owns one child and consumes
the primary `voice` role for join, capture, TTS, and audible music. A text-only
official-bot process does not spawn Vox. The user body can concurrently consume
`stream_watch` and `stream_publish`. Vox is the sole Discord media owner
([ADR 0128](../../../docs/adr/0128-vox-is-the-sole-discord-media-owner.md)).

## Ownership Boundary

Clankie's TypeScript runtime owns:

- platform gateway/session control outside the raw media transport
- the active bot or user account token, gateway, REST, and admission checks
- user-body stream discovery dispatch handling
- session orchestration and product logic
- `DiscordVoiceSession` consent, attribution, floor, realtime-provider, and
  captain-handoff policy
- tools, prompts, settings, and commentary decisions
- deciding whether raw VP8 frames can be promoted; the current product path does
  not decode them and uses Vox-decoded H264 JPEGs

`clankvox` owns:

- platform-specific realtime media sockets
- Discord voice and stream-server sockets
- UDP/RTP send and receive
- codec advertisement and media framing
- DAVE lifecycle and media encryption/decryption
- decoding H264 watch frames to JPEG in-process
  ([../src/video_decoder.rs](../src/video_decoder.rs) on a dedicated decode
  thread), emitted over IPC as `decoded_video_frame`
- capture events and media telemetry
- TTS/music playback pacing
- outbound native Go Live video packetization in the Discord transport

`clankvox` should stay transport-native and deterministic. Clankie should stay
agentic and product-facing.

The account token never crosses this boundary. Once the body validates a join,
only Discord-issued short-lived voice/stream endpoint, token, session, user,
server, and channel fields cross IPC.

## Process Model

Each media-enabled active Discord body creates one app-lifetime client and
child. The entrypoint in [../src/main.rs](../src/main.rs) creates one long-lived
`AppState` and drives it from a single async event loop. A text-only official-bot
process creates neither, and the inactive body is down, so neither can create a
competing child or media owner.

The loop reacts to five sources:

- inbound IPC messages from the Clankie runtime
- `VoiceEvent` messages from active transport connections
- `MusicEvent` messages from the ffmpeg/yt-dlp music pipeline
- reconnect deadlines
- a 20ms tick used for audio send cadence and publish-frame draining

That shape keeps transport logic serialized through `AppState` even though lower-level tasks are running concurrently behind channels.

### Event-Loop Protection

The 20ms tick is the audio cadence, so nothing heavy or blocking runs on the
event loop:

- H264 decode + JPEG encode for watch frames runs on the dedicated
  [../src/video_decode_worker.rs](../src/video_decode_worker.rs) thread behind
  a bounded frame lane (drop-oldest on overflow); decoder-reset PLI requests
  come back over a small bounded lane drained on the capture tick.
- Browser-session publish frames are written to ffmpeg stdin by a dedicated
  writer thread behind a bounded lane (drop-oldest); the event loop never
  performs the write, which can block indefinitely while the pipeline is
  paused (`SIGSTOP`).
- Subprocess teardown joins pipeline threads on detached threads, never
  inline.
- The main loop keeps `MissedTickBehavior::Skip` for the send tick but
  measures inter-tick gaps and logs rate-limited
  `clankvox_audio_tick_slippage` warnings when the cadence slips.

### Fail-Closed E2EE

With a ready DAVE session, an outbound frame that fails encryption is
dropped, never sent plaintext. Consecutive encrypt failures are counted per
path (voice audio, stream-publish video) and a structured
`voice_runtime_error` IPC error is raised when a streak crosses the alert
threshold. Plaintext is only sent while DAVE is absent or still handshaking,
where it is the protocol-correct output.

## Core State

[../src/app_state.rs](../src/app_state.rs) is the shared spine. It holds:

- Discord primary voice connection and pending voice connect inputs
- `stream_watch` connection state and its own DAVE slot
- `stream_publish` connection state and its own DAVE slot
- audio send state for outbound voice playback
- per-user capture state and speaking state
- remote video state and active video subscriptions
- music pipeline state
- stream publish runtime state
- reconnect bookkeeping
- caller-owned primary `connectionId` on join and every primary ready,
  connection, transport, DAVE, and transport-error event, plus one internal
  generation per role

Primary voice teardown is role-scoped. Explicit `leave` sends gateway OP4 with
`channel_id: null`, clears only primary voice credentials, capture/playback,
transport, DAVE, and reconnect state, and leaves `stream_watch` and
`stream_publish` running in the same process.

The important architectural choice is that each Discord transport role has its
own connection slot and its own DAVE manager: a media role with distinct
lifecycle or encryption state gets its own slot. That is why Go Live is not
modeled as “extra fields on the main voice socket.”

Every `VoiceEvent` carries its role generation. Replacing or clearing a
connection advances that generation, so delayed ready, DAVE, media, and
disconnect events from the old socket are ignored. Early DAVE readiness is held
until transport readiness and can never regress to negotiating. Remote video
state, decoder state, and feedback are keyed by role plus user/stream; primary
webcam and stream-watch screen state cannot overwrite or reroute one another.

## Discord Transport Roles

The roles below are ClankVox's transport roles. All three are Discord roles.
Discord is the only platform ClankVox targets today.

### `voice`

The main voice leg for:

- join/leave
- speaking state
- inbound user audio capture
- outbound TTS and music

Both Discord bodies use this role.

### `stream_watch`

A separate stream-server connection used only for inbound Go Live receive:

- connects with `rtc_server_id` and stream credentials from Clankie
- receives remote OP12/OP18 video state
- decrypts video and forwards encoded frames to Clankie over IPC
- never owns the main audio session

Only the user-session body can use this role because Discord bots cannot
receive Go Live pixels.

### `stream_publish`

A separate stream-server connection used only for outbound Go Live send:

- connects with self-owned stream credentials from Clankie
- advertises sender-side H264 support
- announces video state to Discord
- packetizes and transmits outbound H264 access units

Only the user-session body can use this role because Discord bots cannot Go
Live. This is a platform limitation, not a second media implementation.

## Supervisor Split

The code is organized around four operational surfaces:

### Connection Supervisor

[../src/connection_supervisor.rs](../src/connection_supervisor.rs)

Owns:

- join / leave / destroy
- connect and disconnect commands for all roles
- role-specific reconnect handling
- connection teardown when session metadata changes

### Capture Supervisor

[../src/capture_supervisor.rs](../src/capture_supervisor.rs)

Owns:

- inbound speaking and audio events
- video subscription state
- remote video state merge/update logic
- transport-ready hooks for `stream_watch` and `stream_publish`

### Playback Supervisor

[../src/playback_supervisor.rs](../src/playback_supervisor.rs)

Owns:

- audio playback commands from Clankie
- music lifecycle events
- queue draining on the 20ms tick
- buffer depth, transport stats, and TTS playback telemetry
- dispatch of up to four pending stream-publish frames per tick (ffmpeg can
  deliver several access units in one stdout chunk; draining more than one
  per tick keeps RTP timestamps fresh without monopolising the loop)

### Stream Publish Runtime

[../src/stream_publish.rs](../src/stream_publish.rs)

Owns:

- ffmpeg/yt-dlp sender pipeline
- raw H264 access-unit extraction
- pause/resume/stop handling for the sender subprocess
- sender runtime events and frame queueing into `AppState`

## IPC Contract

[../src/ipc.rs](../src/ipc.rs) is the Clankie runtime contract.

Inbound commands are grouped into four conceptual families:

- connection: a caller-owned `connectionId` on primary join; leave and voice
  server/state updates for the active primary connection; stream-watch
  connect/disconnect; stream-publish connect/disconnect
- capture: capture-ID-scoped subscribe/unsubscribe user audio and user video
- playback/lifecycle: playback-ID-scoped TTS audio (`audio`), ordered `finish_tts_playback`, targeted `stop_tts_playback`, music-ID-scoped play/pause/resume/stop/gain, destroy
- stream publish runtime: `stream_publish_play`, `stream_publish_browser_start`, `stream_publish_browser_frame`, pause, resume, stop

Stdin is read with a hard per-line cap (8MB): an oversized line is discarded
up to its newline and reported as an `input_too_large` error; invalid UTF-8
and malformed JSON lines are skipped with an `invalid_json` error. No single
bad line can kill the reader or force a full shutdown.

Outbound events are also grouped:

- process / adapter / connection state: `process_ready`, `ready`,
  `adapter_send`, `connection_state`
- transport state per role: `transport_state`
- negotiated encryption state per role: `dave_state`; transport readiness and
  positive DAVE readiness are separate events
- speaking and user audio capture: `speaking_start`/`speaking_end`,
  capture-correlated `user_audio` (binary framing), `user_audio_end`,
  `client_disconnect`
- user video: raw VP8 frames as `user_video_frame` and in-process-decoded H264
  JPEG frames as `decoded_video_frame`
- playback and music lifecycle: `player_state`, `playback_armed`, correlated
  `tts_playback_state`, `music_idle`, `music_error`, `music_gain_reached`
- telemetry: `buffer_depth`, `transport_stats`, `tts_buffer_overflow`
- structured IPC errors (`error`); transport tracing stays on stderr

`process_ready` carries the explicit IPC protocol version and is process/IPC
readiness only. The TypeScript client accepts no command before an exact version
match. It never substitutes for a role's `transport_state=ready`, and transport
readiness never substitutes for positive, role-scoped `dave_state=ready`.
Primary voice `ready`, `connection_state`, `transport_state`, `dave_state`, and
transport errors carry the caller's `connectionId`; stream roles use their own
internal generation instead. Fresh media-enabled app evidence identifies
`mediaOwner: vox`; a text-only bot identifies `mediaOwner: none`. Watch and
publish retain separate role proofs. A clean `voice` leave preserves the other
roles, while body shutdown destroys all roles and the sole child.

`tts_playback_state` is playback-ID-scoped transport truth: `buffered` means PCM
was accepted into the queue, `started` means the first audible TTS-containing
RTP frame was successfully transmitted, and `drained` follows
`finish_tts_playback` only after PCM, a held partial tail, and trailing output
frames have crossed the sender. `stopped` and `failed` are terminal alternatives.

### Telemetry Semantics

`buffer_depth` reports current TTS/music queue depth as samples. It is emitted
when TTS PCM is enqueued, while playback buffers are non-empty, and when the
buffers drain so the TypeScript side can track floor state without inferring it
from speech text.

`transport_stats` reports cumulative transport counters and timing gauges while
any Discord transport is connected (`voice`, `stream_watch`, or
`stream_publish`). The playback tick runs every 20ms; `transport_stats` emits
every 250 ticks, about every 5s, and the cadence counter resets while no
transport is connected. Counters are cumulative since the ClankVox process
started. The snapshot includes tick cadence (`total`, `skipped`, `slipEvents`,
`maxGapMs`), control/audio/video IPC lane drops, inbound audio decrypt/loss/concealment counters,
inbound video decode/DAVE counters, and outbound RTP/encrypt-failure counters.

### Writer Lanes

The stdout writer thread drains three bounded lanes in priority order: control
(4096), ordered capture audio (512), then video (64). Control and capture audio
backpressure producers rather than dropping. `user_audio_end` uses the same FIFO
as its PCM, so it cannot overtake a queued tail. Video remains lossy and counted
on overflow. A stalled parent therefore caps subprocess memory at the lane
depths without reporting successful truncated capture or playback.

## Module Map

Core loop and state:

- [../src/main.rs](../src/main.rs): entrypoint, event loop, send-tick slippage monitor
- [../src/app_state.rs](../src/app_state.rs): shared state, transport slots, encrypt-failure counters, decode scratch buffers

Discord transport (`voice_conn` module tree):

- [../src/voice_conn.rs](../src/voice_conn.rs): module root (connection handle, connect/shutdown lifecycle, events, transport roles)
- [../src/voice_conn/protocol.rs](../src/voice_conn/protocol.rs): Discord voice opcode payloads, codec negotiation payloads, and stream descriptor helpers
- [../src/voice_conn/handshake.rs](../src/voice_conn/handshake.rs): handshake receive helpers (Hello/Ready/Session Description) and UDP IP discovery
- [../src/voice_conn/ws_ops.rs](../src/voice_conn/ws_ops.rs): WS read/write loops and text/binary opcode handling (speaking, video state, DAVE MLS opcodes)
- [../src/voice_conn/udp_rx.rs](../src/voice_conn/udp_rx.rs): UDP receive loop, frame decrypt orchestration, lazy fallback replay
- [../src/voice_conn/video_frames.rs](../src/voice_conn/video_frames.rs): inbound video depacketizer state and alternate-payload fallback frame assembly
- [../src/voice_conn/tx.rs](../src/voice_conn/tx.rs): outbound RTP audio/video packetization and protected RTCP feedback (PLI/FIR)
- [../src/voice_conn/diagnostics.rs](../src/voice_conn/diagnostics.rs): DAVE-marker helpers for decrypt diagnostics

Media and crypto:

- [../src/dave.rs](../src/dave.rs): DAVE session management, codec-aware encrypt/decrypt helpers, candidate-user decrypt search
- [../src/transport_crypto.rs](../src/transport_crypto.rs): RTP transport AEAD (AES-256-GCM / XChaCha20-Poly1305 `rtpsize` modes)
- [../src/rtp.rs](../src/rtp.rs): RTP header build/parse, padding/extension stripping, codec payload types
- [../src/rtcp.rs](../src/rtcp.rs): protected RTCP packet construction
- [../src/h264.rs](../src/h264.rs) / [../src/vp8.rs](../src/vp8.rs): codec depacketizers and Annex-B helpers
- [../src/video_decoder.rs](../src/video_decoder.rs): persistent OpenH264 decoder, YUV→RGB, and JPEG encode
- [../src/video_decode_worker.rs](../src/video_decode_worker.rs): dedicated H264 decode thread, fps gate, `decoded_video_frame` emission, PLI feedback lane
- [../src/video.rs](../src/video.rs): video stream descriptors, subscriptions, and state helpers
- [../src/video_state.rs](../src/video_state.rs): remote video state payloads and OP12 announcements
- [../src/media_sink_wants.rs](../src/media_sink_wants.rs): media sink wants payload construction
- [../src/audio_pipeline.rs](../src/audio_pipeline.rs): PCM buffering, TTS/music mixing, resampling, Opus encode
- [../src/capture.rs](../src/capture.rs): per-user capture and speaking state types
- [../src/music.rs](../src/music.rs): music pipeline subprocess management
- [../src/stream_publish.rs](../src/stream_publish.rs): outbound Go Live sender pipelines and browser-frame stdin writer
- [../src/process_unix.rs](../src/process_unix.rs): shell pipelines and process-group signalling

IPC:

- [../src/ipc.rs](../src/ipc.rs): message contracts, prioritized stdout writer lanes, capped stdin reader
- [../src/ipc_router.rs](../src/ipc_router.rs): dispatches inbound commands directly into supervisors

## Transport-Owned Mixing Rules

One product-flavored mixing rule currently lives in the transport plane,
inside [../src/playback_supervisor.rs](../src/playback_supervisor.rs):

- **TTS-vs-music arbitration:** inbound TTS PCM is rejected while music is
  actively playing unless music is ducked, and TTS always mixes at full
  volume over gain-enveloped music.

This is documented here as a transport-owned mixing rule because it decides
_what the listener hears_, not just how bytes move, which strains the
"ClankVox stays deterministic, Clankie applies product policy" boundary. It is
a candidate to move upstream behind explicit duck commands. A
policy-approved `music_play` starts its pipeline immediately; Vox never waits
for unrelated TTS tool-result playback.

## Why The Architecture Looks This Way

The Discord implementation is shaped by DAVE and Go Live.

Songbird-level abstractions were not sufficient because:

- DAVE control opcodes live on the voice WebSocket
- media encryption/decryption has to be coordinated with codec framing
- Go Live uses a second stream-server connection with different state and lifecycle needs
- sender and receiver roles need different codec and announcement behavior

That is why the Discord implementation is a custom transport layer instead of a
thin wrapper around an off-the-shelf Discord voice library. This is the boundary
the whole plane encodes: ClankVox owns platform media mechanics (native timing,
codecs, encryption, telemetry) and Clankie owns the agent behavior above it.
