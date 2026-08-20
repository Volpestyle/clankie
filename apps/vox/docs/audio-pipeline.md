# Audio Pipeline

This document covers the audio path inside `clankvox`: inbound user capture,
outbound TTS/music playback, and the telemetry Clankie relies on for floor
control. The Discord-backed implementation follows the same boundary future
platform transports should keep too: ClankVox owns low-level media mechanics;
Clankie owns agent policy.

## Scope

Audio in `clankvox` has two big jobs:

- turn platform voice packets into Clankie-visible user audio events
- turn Clankie-visible TTS/music/media commands into platform voice playback

For the Discord transport, those packets are Discord RTP/Opus/DAVE frames on
the `voice` role.

Go Live video send/receive is documented separately in [go-live.md](./go-live.md).

This is the live ordinary-voice and audible-music path for both Discord bodies.
The personal-lab user body can run its separate screen-watch and Go Live roles
concurrently; those roles do not replace or carry music audio.

## Inbound Audio Receive

The Discord `voice` transport receives RTP packets from Discord and processes
them in this order:

1. RTP header parse (this locates the payload; transport decrypt recomputes the
   fixed-header, CSRC, and extension-prefix AAD described in
   [go-live.md](./go-live.md), rather than using the full `header_size`)
2. transport decrypt using the negotiated RTP-size AEAD mode
3. SSRC-to-user lookup for the speaking user
4. DAVE decrypt for that user
5. Opus decode to PCM
6. channel conversion / resampling into Clankie-facing capture format
7. speaking and user-audio IPC emission

At the Clankie boundary, capture is exposed through events like:

- `speaking_start`
- `speaking_end`
- `user_audio`
- `user_audio_end`
- `client_disconnect`

Those events are what the higher-level voice session manager uses to decide when a speaker has actually taken the floor and when ASR input is ready to finalize.
Each audio subscription carries a caller-provided `captureId`. Binary PCM and
the applicable speaking/end lifecycle carry that ID, and stale frames from a
superseded subscription are never relabeled as the new capture. Output remains
mono PCM at the requested rate, normally 24kHz.

## Outbound Playback

Outbound playback is paced on the 20ms tick from [../src/main.rs](../src/main.rs).

Sources:

- live TTS audio pushed from Clankie over IPC
- music PCM produced by the local ffmpeg/yt-dlp pipeline

The normal send path is:

1. Clankie sends PCM to `clankvox`
2. `clankvox` buffers and normalizes it for platform send
3. on each 20ms tick, the next frame is encoded to Opus
4. DAVE encrypt runs when the session is in encrypted mode. A frame that
   fails encryption is dropped, never sent plaintext (fail closed)
5. transport AEAD encrypt wraps the RTP payload
6. packet is sent over UDP

This is why Clankie does not send Opus frames directly in the Discord transport.
`clankvox` keeps pacing, codec, and encryption truth local to the transport
layer.

TTS PCM is scoped by `playbackId`. Clankie sends all PCM followed by
`finish_tts_playback` on the same ordered stdin lane. Vox emits `buffered` when
PCM first enters the queue, `started` only after an audible TTS-containing RTP
frame is successfully transmitted, then `drained` only after PCM, a held partial
tail, and trailing output frames have actually crossed the sender. Targeted stop
and failures emit `stopped` and `failed`; stale playback IDs are dropped.

The TTS cap is fail-closed. A chunk that would exceed it is not partially
accepted: Vox clears that playback, emits playback-correlated
`tts_buffer_overflow` and `tts_playback_state=failed`, and permanently rejects
later chunks or finish for that playback ID. On capture output,
`user_audio_end` shares the reliable PCM FIFO and can never pass the final
audio frame under stdout backpressure.

## Music Playback

Music is implemented as a local subprocess pipeline in [../src/music.rs](../src/music.rs).

Music playback typically:

- resolves media with `yt-dlp`
- decodes to raw PCM with `ffmpeg`
- pushes PCM chunks into the same outbound playback path used for TTS

Music also emits lifecycle events back into the main loop, including:

- `music_idle`
- `music_error`
- `music_gain_reached`

Commands, PCM chunks, and lifecycle events carry `musicId`, so an old pipeline
cannot advance the current queue entry. A policy-approved request starts
immediately; pause, resume, stop, gain envelopes, yt-dlp, and ffmpeg remain
transport-owned.

Pause, desired gain/duck, resume, and stop are valid while the pipeline is still
starting. The subprocess applies pending pause/resume after spawn, first PCM
fades toward the requested gain rather than resetting it, and a stopped ID
cannot be revived by a delayed first-PCM event. Before first PCM only,
classified `http_403` or `format_unavailable` failures retry once with a strict
audio-bearing HLS selector; failures after first PCM never retry. `music_error`
reports the content-free classification separately from its redacted human
message.

Those events drive the shared `DiscordVoiceSession.music` queue in both bodies,
including automatic end-of-track advancement.

## TTS Buffering And Telemetry

Clankie intentionally does not assume audio is “done” as soon as it has sent all PCM to the subprocess.

`clankvox` emits playback telemetry so Clankie can reason about actual floor
occupancy. Queued `buffered` audio does not hold the floor; `started` begins
audible occupancy, and `drained` ends it:

- `buffer_depth`
- `tts_playback_state`
- `player_state`
- `playback_armed`

That telemetry is used for:

- output lock decisions
- barge-in timing
- safe music resume timing
- draining queued assistant utterances only when the subprocess really has headroom

## Capture And Floor Semantics

`clankvox` reports low-level transport truth. It does not decide whether the agent should answer.

Examples:

- it reports that a user started speaking
- it reports PCM bytes and end-of-capture boundaries
- it reports that buffered TTS still exists

Clankie then decides:

- whether the capture promotes into a turn
- whether it interrupts current playback
- whether the agent answers or stays silent

That boundary is deliberate. The subprocess should not become a policy engine.

## Key Files

- [../src/voice_conn.rs](../src/voice_conn.rs): RTP receive/send, Opus, packet encryption
- [../src/dave.rs](../src/dave.rs): DAVE encrypt/decrypt for audio and video codecs
- [../src/audio_pipeline.rs](../src/audio_pipeline.rs): outbound audio buffer state
- [../src/playback_supervisor.rs](../src/playback_supervisor.rs): playback commands, tick-driven draining, telemetry
- [../src/capture_supervisor.rs](../src/capture_supervisor.rs): speaking and capture state
- [../src/music.rs](../src/music.rs): music subprocess lifecycle

## Important Constraints

- playback pacing is owned locally by `clankvox`, not Clankie
- audio transport truth is ultimately the subprocess state, not just Clankie-side queued bytes
- DAVE transitions can temporarily change whether frames are encrypted or passthrough
- buffer telemetry is operational truth but not durable forever; Clankie still ages stale positive samples on its side
- capture and playback truth is exposed over IPC so floor-control policy stays
  in Clankie and never moves into `clankvox`
