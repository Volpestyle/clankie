# integrations/gba-emulator/test/real-mgba.test.ts

Real-core suite: `decodeLibretroMemoryMap`
against a synthetic wasm32 heap (the ABI-level
descriptor-stride check), `nextRealRouteStep`
routing around blocked edges,
`runRealGbaScenario` with stub seam cores
(desync fails closed, refused steps become
blocked edges), and — when
`CLANKIE_GBA_ROM_PATH` + savestate are set —
the full ROM-gated path: core identity
verification, decoded overworld, and the
bedroom route on the real mGBA core.
