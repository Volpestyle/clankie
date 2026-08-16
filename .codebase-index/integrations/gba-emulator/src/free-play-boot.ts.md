# integrations/gba-emulator/src/free-play-boot.ts

`bootGbaGame` — the one shared path that
resolves which game Clankie is looking at
(shared by the free-play CLI and the MCP
server so ROM digests are checked in exactly
one place).

Existence-gated on the operator-local game
home `~/.local/share/clankie/gba/`
(`defaultGbaGameDir`, XDG-aware): with
`firered.gba` + `firered-bedroom.state` (or
env paths) it boots the real
`MgbaFireRedCore`; for environment id
`pokemon-emerald` it requires `emerald.gba` +
`emerald-title.state` and boots the
framebuffer-only `MgbaVisualCore`; with
nothing it falls back to the deterministic
double so the surface works without
copyrighted bytes. Returns `BootedGbaGame`:
scenario + fixture digest, optional core
factory, optional `GbaCheckpointCapability`
(save/load/bootSavestate/identity/scenario —
absent on the double), `framePng(scale)`,
`observeFrames`, `framebufferSha256`, and the
`real` flag. Re-exports
`defaultGbaBodyRootDir` from
`@clankie/body-lock`.
