# @clankie/vox-client

Apache-2.0 TypeScript process boundary for the AGPL `@clankie/vox` native
media executable.

Each media-enabled active Discord body owns one client and one child; a
text-only official-bot process owns neither. Both media-enabled bodies consume
primary voice, capture, TTS, and music commands; the user body can concurrently
consume screen-watch and Go Live commands. See
[ADR 0128](../../docs/adr/0128-vox-is-the-sole-discord-media-owner.md) and the
[Discord media guide](../../docs/discord-media.md).

The client resolves the workspace release/debug binary, with
`CLANKIE_VOX_BIN` as an explicit override. It owns child lifecycle, bounded
stdout framing, full media-plane commands, a discriminated control-event union,
decoded screen-share frames, and capture-correlated binary speaker-audio
frames. Listener registration returns independent unsubscribe functions so one
process-lifetime client can serve voice, watch, and publish controllers.

`process_ready` carries `VOX_IPC_PROTOCOL_VERSION`; the client remains
unavailable and refuses commands until that exact version is received. Missing
or mismatched binaries enter `error` and are terminated rather than using a
compatibility protocol.

Primary voice has an explicit caller-owned `connectionId` on `joinVoice` and on
primary `ready`, `connection_state`, `transport_state`, `dave_state`, and
transport-error events. TTS uses `playbackId` plus ordered
`finishTtsPlayback`: `buffered` means queued, `started` means the first audible
TTS frame was successfully transmitted, and `drained` means all finished
playback output crossed the sender. Capture uses caller-owned `captureId`; music
uses `musicId`. Reliable stdin commands never drop under backpressure: bounded
overflow fails the client and throws `VoxClientError` with the applicable
playback correlation. `process_ready`, voice transport readiness, and positive
role-scoped DAVE readiness remain separate facts.

Video frame events include their originating transport role. Music failures
carry a content-free `code` and a separate redacted human `message`.

Discord product policy stays in the consuming body. The client translates
typed calls to IPC and reports transport facts; it does not decide who may
join, listen, speak, or publish. Account gateway tokens also stay in the body;
only Discord-issued short-lived voice/stream connection fields cross IPC.
