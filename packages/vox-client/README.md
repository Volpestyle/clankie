# @clankie/vox-client

Apache-2.0 TypeScript process boundary for the AGPL `@clankie/vox` native
media executable.

The client resolves the workspace release/debug binary, with
`~/.clankie/bin/clankvox` as a compatibility fallback and
`CLANKIE_VOX_BIN` as an explicit override. It owns child lifecycle, bounded
stdout framing, full media-plane commands, generic control events, decoded
screen-share frames, and binary speaker-audio frames.

Discord product policy stays in the consuming body. The client translates
typed calls to IPC and reports transport facts; it does not decide who may
join, listen, speak, or publish.
