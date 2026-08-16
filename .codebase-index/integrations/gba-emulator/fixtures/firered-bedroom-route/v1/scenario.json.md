# integrations/gba-emulator/fixtures/firered-bedroom-route/v1/scenario.json

`RealGbaRouteScenarioSchema` fixture: the
bounded bedroom route in
`pallet-town/players-house-2f`. Pins the
FireRed US v1.0 ROM, the `firered-a-bedroom-v1`
savestate, and the mGBA core wasm by SHA-256,
plus the probed tile map (bounds 8-18 x 9-15
with the verified blocked set), start (13,13),
target (9,11), 16 hold-frames per step, and
the default `reach_target` goal. Every tile in
`blocked` was probed against the running ROM.
