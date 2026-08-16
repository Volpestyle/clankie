# integrations/gba-emulator/src/mgba-core.ts

`MgbaLibretroCore` — the in-process,
single-threaded libretro driver for the pinned
mGBA WASM core (`romdev-platform-gba@0.11.0`).
No frontend, no audio, no timers, no network:
the caller pumps `retro_run()` one frame at a
time and reads GBA memory and the framebuffer
straight out of the WASM heap.

Implements the libretro environment callback
(pixel format, memory maps, variables), copies
RGB565 frames out of the heap with pitch
removed, injects keypad state via a keymask,
and exposes: `loadRom`, `setHeldButtons`,
`runFrames`, `readEwram` (256 KB, with a
legacy system-RAM fallback), `readIwram`
(32 KB), `framebuffer()`, `saveState` /
`loadState` (retro_serialize), and
`decodeLibretroMemoryMap` (exported for an
ABI-level test; wasm32 descriptor stride is
40 bytes due to u64 flags alignment).
`mgbaCoreWasmSha256()` hashes the pinned wasm
binary for supply-chain verification.
Determinism comes from frame-stepped
execution: same ROM + savestate + inputs =
byte-identical RAM and frames.
