# integrations/gba-emulator/src/visual-core.ts

`MgbaVisualCore` — the real mGBA body for
cartridges without a verified RAM decoder
(Pokémon Emerald). The framebuffer, buttons,
RAM digest, and savestates are real; semantic
state is deliberately absent: `gameState()`
reports mode "unknown" so the adapter exposes
only the screen and raw controls instead of
interpreting Emerald through FireRed offsets.

`VisualGbaScenarioSchema` pins the
framebuffer-only scenario (ROM / savestate /
core-wasm digests); `create()` fails closed on
any mismatch and boots from the pinned title
savestate, which `bootSavestate()` retains for
restarts. Same press/settle timing,
`observeFrames` pacing, and checkpoint
save/load surface as the FireRed core.
