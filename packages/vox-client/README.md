# @clankie/vox-client

Apache-2.0 TypeScript process boundary for the AGPL `@clankie/vox` native
media executable.

The current rollout consumes screen-watch and Go Live commands from the active
lab user body. Ordinary Discord voice/music remains on `@discordjs/voice`; see
[ADR 0100](../../docs/adr/0100-vox-is-an-owned-native-media-package.md) and the
[Discord media guide](../../docs/discord-media.md).

The client resolves the workspace release/debug binary, with
`~/.clankie/bin/clankvox` as a compatibility fallback and
`CLANKIE_VOX_BIN` as an explicit override. It owns child lifecycle, bounded
stdout framing, full media-plane commands, generic control events, decoded
screen-share frames, and binary speaker-audio frames.

Discord product policy stays in the consuming body. The client translates
typed calls to IPC and reports transport facts; it does not decide who may
join, listen, speak, or publish.
