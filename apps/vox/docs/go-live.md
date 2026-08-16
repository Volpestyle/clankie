# Go Live: Native Screen Watch And Self Publish

This document consolidates the Discord Go Live transport inside `clankvox`.

ClankVox is Clankie's main native package for voice and media transport. Go Live
is the first video-heavy platform implementation living there, not the whole
scope of the crate.

It covers:

- inbound native screen watch (`stream_watch`)
- outbound native self publish (`stream_publish`)
- how Clankie and the selfbot gateway feed stream credentials into the subprocess

## Mental Model

Discord Go Live is not “extra fields on the normal voice socket.”

The main voice connection and the Go Live stream connection are separate legs:

- main voice leg: normal audio send/receive, speaking, voice session identity
- stream leg: video receive or send, stream-specific SSRCs, stream-server credentials

That is why the Discord transport models Go Live as extra transport roles
instead of trying to force everything through the primary `voice` slot.

## Control Plane Vs Media Plane

Clankie and the selfbot gateway own the control plane:

- raw gateway dispatch handling
- stream discovery
- OP18 `STREAM_CREATE`
- OP19 `STREAM_DELETE`
- OP20 `STREAM_WATCH`
- OP22 `STREAM_SET_PAUSED`
- deciding which session should attach to which stream

`clankvox` owns the Discord media plane:

- stream-server WebSocket connection
- UDP media send/receive
- codec advertisement and selection
- DAVE and transport encryption
- inbound frame forwarding
- outbound H264 packetization

## Shared Stream Facts

For both watch and publish, Clankie eventually supplies:

- stream endpoint
- stream token
- `rtc_server_id`
- main voice `session_id`
- self user id
- DAVE channel id

The DAVE channel derivation for stream connections is:

```text
BigInt(rtc_server_id) - 1
```

That value is computed in Clankie and passed to `clankvox` over IPC.

## `stream_watch` Flow

Inbound native watch works like this:

1. Clankie discovers an active Go Live stream for a target user
2. Clankie sends OP20 `STREAM_WATCH`
3. Discord returns `STREAM_CREATE` and `STREAM_SERVER_UPDATE`
4. Clankie calls `stream_watch_connect`
5. `clankvox` opens the stream-server transport
6. Discord sends video state and media
7. `clankvox` decrypts/depacketizes frames and emits:
   - `user_video_state`
   - `user_video_frame`
   - `user_video_end`
8. clankvox decodes H264 access units to JPEG in-process (`decoded_video_frame`); Clankie decodes sampled VP8 keyframes to JPEG and feeds the higher-level screen-watch pipeline

The receiver path supports H264 and VP8 receive.

## `stream_publish` Flow

Outbound self publish works like this:

1. Clankie decides to publish a self-owned stream
2. if needed, Clankie sends OP18 `STREAM_CREATE`
3. Clankie sends OP22 `STREAM_SET_PAUSED { paused: false }`
4. Discord returns self stream discovery and credentials
5. Clankie calls:
   - `stream_publish_connect`
   - `stream_publish_play` for URL-backed publish, or
   - `stream_publish_browser_start` followed by repeated `stream_publish_browser_frame`
6. `clankvox` opens the sender-side stream transport
7. `clankvox` advertises H264 sender capability and announces active video state
8. `clankvox` turns the active source into H264 access units:
   - URL-backed publish uses ffmpeg/yt-dlp
   - browser-session publish feeds PNG frames into ffmpeg over stdin
9. each access unit is DAVE-encrypted, RTP-packetized, and sent over UDP

Pause/resume/stop are split cleanly:

- pause: Clankie sends OP22 paused true and `stream_publish_pause`
- resume: Clankie reuses the existing stream when possible and sends OP22 paused false plus `stream_publish_resume`
- stop: Clankie sends OP19 `STREAM_DELETE` and `stream_publish_stop` / `stream_publish_disconnect`

## Sender Boundary

The Discord sender path exists, but it is not yet a general-purpose arbitrary
video publisher.

Rollout:

- publish lifecycle is tied to Clankie-owned source orchestration
- source support is intentionally narrow and centered on:
  - YouTube-backed music/video URLs
  - browser-session PNG frames captured on the Clankie side
    (the active Clankie user-session body supplies these snapshots)
- sender codec is H264
- transport is the native Discord stream server path, not the share-link fallback path

## Key Files

- [../src/voice_conn.rs](../src/voice_conn.rs): module root, connection lifecycle, events, and transport roles
- [../src/voice_conn/protocol.rs](../src/voice_conn/protocol.rs): opcode payloads, codec negotiation, and stream descriptors
- [../src/voice_conn/handshake.rs](../src/voice_conn/handshake.rs): Hello/Ready/Session Description and UDP discovery
- [../src/voice_conn/ws_ops.rs](../src/voice_conn/ws_ops.rs): WebSocket loops and voice/DAVE opcode handling
- [../src/voice_conn/udp_rx.rs](../src/voice_conn/udp_rx.rs): UDP receive, DAVE decrypt, and frame assembly orchestration
- [../src/voice_conn/video_frames.rs](../src/voice_conn/video_frames.rs): video depacketizers and fallback frame assembly
- [../src/voice_conn/tx.rs](../src/voice_conn/tx.rs): outbound RTP video packetization and RTCP feedback
- [../src/stream_publish.rs](../src/stream_publish.rs): sender pipeline and H264 frame feed
- [../src/video.rs](../src/video.rs): stream descriptors and subscription state
- [../src/capture_supervisor.rs](../src/capture_supervisor.rs): watch-ready handling and subscriptions
- [../src/connection_supervisor.rs](../src/connection_supervisor.rs): role-specific connect/disconnect
- [../src/ipc.rs](../src/ipc.rs): `stream_watch_*` and `stream_publish_*` IPC messages

## Transport Crypto: rtpsize AAD Rules

Discord's `aead_aes256_gcm_rtpsize` and `aead_xchacha20_poly1305_rtpsize` modes
authenticate different slices of the packet depending on packet type:

- **RTP media packets:** AAD = RTP fixed header (12 bytes) + CSRC list (cc * 4
  bytes) + 4-byte extension header prefix (profile + length). The extension
  body is part of the ciphertext, not the AAD. `parse_rtp_header` returns a
  `header_size` that includes the full extension body. This value is correct
  for locating the payload start but must NOT be used as the AAD boundary.
  `decrypt()` recomputes the AAD from the raw packet bytes.
- **RTCP packets:** AAD = the 4-byte RTCP fixed header. `decrypt_with_aad()`
  is used directly with `RTCP_HEADER_LEN`.

Inbound RTCP packets (payload types 72-76 after masking, corresponding to RTCP
types 200-204 per RFC 5761 mux) are filtered early in the UDP recv loop before
any decrypt attempt. They are silently skipped because we do not process
inbound RTCP feedback.

## H264 Keyframe and SPS Strategy

Discord's raw UDP protocol path does not honour PLI or FIR RTCP feedback for
keyframe requests. PLI/FIR only works through the WebRTC protocol path used by
reference implementations like `Discord-video-stream`. Since clankvox uses
`protocol: "udp"`, we cannot request keyframes on demand. PLI/FIR packets are
still sent as a best-effort hint in three scenarios: periodic reassertion
(every 2s), after decoder reset (50 consecutive errors), and after DAVE ready.

To compensate:

- Cached SPS+PPS are prepended to every emitted frame after DAVE decrypt.
  `prepend_cached_parameter_sets` is a no-op when the frame already contains
  inline parameter sets. The prepend happens after DAVE decrypt (not during
  depacketization) so that DAVE trailer byte offsets remain correct.
- Only IDR slices (NAL type 5) are treated as keyframes for rate-limiting and
  forwarding purposes.
- The persistent OpenH264 decoder processes all frames (IDR + P-frames) for
  reference state accumulation with error concealment enabled. The first
  decoded frame may have visual artifacts, but subsequent frames improve as
  P-slice prediction converges. After 50 consecutive decode errors the decoder
  auto-resets and requests PLI.

## DAVE Video Decrypt

DAVE video decrypt works at near 100% on the **main voice connection**.
`strip_rtp_padding()` in `rtp.rs` strips RTP padding bytes before
depacketization, so AES-GCM tag verification succeeds on padded FU-A
mid-fragments.

Go Live encrypts **each RTP packet**. Voice/webcam encrypt the assembled
access unit and then FU-A packetize it. Treating Go Live like voice meant
the H264 depacketizer saw encrypted first-bytes (not NAL type 28) and
dropped every packet after the unencrypted IDR window.

The receive path now decrypts any RTP payload that carries a DAVE trailer
**before** depacketization, including FU-A, and remaps the SSRC if a
different known user decrypts the packet. A completed access unit is
emitted as already-plain only when **every** marked packet in that unit
decrypted — not just the last one. The alternate RTP-extension fallback
is decrypted the same way, so a wrong extension strip cannot reassemble
ciphertext. Frame-level encryption is unchanged: unmarked start/mid
fragments still assemble, then decrypt.

`davey` is 0.1.4 (libdave video-processing parity). PLI/FIR on the raw UDP
path remains best-effort; cached SPS+PPS and the persistent OpenH264
decoder still cover keyframe recovery.

## Video Decode (OpenH264 in-process; VP8 via ffmpeg)

H264 decode is handled entirely in-process by clankvox's persistent OpenH264
decoder (`video_decoder.rs`), running on a dedicated decode thread
(`video_decode_worker.rs`) behind a bounded drop-oldest frame lane so decode
and JPEG encode never stall the event loop. The fps gate runs between decode
and JPEG encode: every frame feeds the decoder's reference state, but
rate-limited frames skip the encode entirely. H264 frames do not use ffmpeg.

VP8 still uses per-frame ffmpeg decode on the Clankie side. The ffmpeg raw demuxer
hangs on single-frame input; Clankie works around this by piping through
`cat | ffmpeg -fflags +genpts -f ivf -i pipe:0` which guarantees clean pipe
close and EOF delivery.
