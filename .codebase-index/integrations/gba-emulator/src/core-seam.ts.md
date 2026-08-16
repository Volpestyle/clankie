# integrations/gba-emulator/src/core-seam.ts

The adapter-facing core interface. All three
cores (test double, real FireRed, Emerald
visual) implement `GbaCoreSeam`, so the
governed surface never changes when the core
swaps.

`GbaCoreSeam`: async `pressButton`,
`advanceFrames`,
optional `advanceFramesHolding` (held A/B
accelerates FireRed's text printer), a typed
`gameState()` view, optional `mapGrid()`
collision query for pathing (a query, not a
state field — copying the grid per observation
would be wasteful), and RAM/framebuffer
SHA-256 digests for evidence. Also defines
`GbaCoreMapGrid` (exclusive-max bounds +
`isPassable`, which ignores NPCs),
`GbaAdapterScenario` (the structural scenario
subset the adapter consumes; `trainer` is
optional for real-core scenarios), and
`GbaCoreFactory`.

Optional synchronous `idleFrames` runs the watched
console between actions and no-ops while an action
owns the core, preventing an idle tick from
releasing held input.
