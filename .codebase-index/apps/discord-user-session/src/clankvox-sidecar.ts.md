# apps/discord-user-session/src/clankvox-sidecar.ts

Apache-licensed client for an externally installed AGPL ClankVox sidecar used to decode or publish Discord Go Live media. `createClankvoxSidecar()` drives NDJSON commands over stdin and decodes the framed stdout protocol; `resolveClankvoxBin()` locates the configured binary.

`ClankvoxFrameDecoder` enforces format and 32 MiB frame bounds without vendoring the sidecar into this repository.
