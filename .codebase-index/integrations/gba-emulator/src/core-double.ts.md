# integrations/gba-emulator/src/core-double.ts

`DeterministicGbaCoreDouble` — clearly-labeled
test infrastructure, not a product simulator:
a fully deterministic in-memory stand-in for
the real core so the adapter, driver, and
runtime integration prove byte-replayable in
CI without a ROM.

Also the home of the shared state types every
core returns: `GbaCoreState` (mode, position,
facing, dialog, menu, naming keyboard,
inventory, party, battle, surroundings,
mapSize, exits) and its sub-interfaces, plus
utility exports `canonicalJson`, `sha256`, and
`savestateIdentitySha256` (the double's
savestate "digest" is derived from its id).

The double models: overworld movement with
blocked tiles, a trainer whose dialog leads to
a simplified battle (LCG RNG seeded from the
scenario, XOR-cursor 2x2 move menu), start/
party/bag field menus, and dialog print timing
(20-frame print, 4x speedup while A/B held).
Determinism anchors: the frozen fixture, the
savestate identity digest, and the RNG seed —
no clock, no Math.random, no I/O.
