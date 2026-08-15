# integrations/gba-emulator/test/map-grid.test.ts

Tests pathing without a core: `planWalk` BFS
over hand-built ASCII grids (detours, no-path,
search bounds), `planWalkBeside` for
pressed-into warp tiles,
`nearestReachableDetail` phrasing, and
`renderWalkabilityMinimap` cropping/symbols.
Includes ROM-gated checks of the double's and
real core's `mapGrid` when a ROM is
configured.
