# docs/adr/0090-emerald-plays-from-the-screen.md

Pokémon Emerald joins asked play as a
screen-only body: `pokemon-emerald` boots a
verified BPEE rev-0 ROM and a digest-pinned title
savestate through `MgbaVisualCore` — real
framebuffer, raw buttons, frame advance, digests,
checkpoints, scene mode `unknown`.

Read for the boundary: no FireRed offsets are
ever applied (wrong state is more dangerous than
absent state), so decoded observations and
composite actions refuse with
`semantic_state_unavailable` until verified
Emerald decoders land. Emerald's RTC is why the
savestate is pinned rather than generated at
boot. CI stays ROM-free; one ROM-gated test
proves a button changes the title frame.
