# docs/adr/0040-real-mgba-core-behind-the-emulator-seam.md

The real core: pinned mGBA WASM
(`romdev-platform-gba@0.11.0`) driven in-process
over the libretro C ABI — frame-stepped, no
timers, no audio device, no sockets. Implements
the same `GbaCoreSeam` as the test double, so CI
stays ROM-free.

Read for the determinism model (SHA-256 pins for
ROM, savestate, and wasm; fail-closed on
mismatch; two-run byte-identical proofs), the
EWRAM/IWRAM memory-map access, how RAM offsets
were verified by input differencing, and the
observed-collision re-plan rule in the route
driver. Operator env paths supply ROM/savestate;
bytes never enter the repo.
