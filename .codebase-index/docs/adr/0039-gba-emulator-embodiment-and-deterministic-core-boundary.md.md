# docs/adr/0039-gba-emulator-embodiment-and-deterministic-core-boundary.md

Founding GBA ADR: `integrations/gba-emulator` is
an EnvironmentAdapter with strict fail-closed
contracts, driven by a state-derived driver
(observe / decide / act once / verify — never an
input transcript), evidenced by hash-chained
traces.

Read for the seam design: the deterministic core
test double stands behind the exact adapter-facing
seam the real core (ADR 0040) later filled, so CI
proves everything without a ROM. ROM/BIOS/
savestate bytes never enter the repo, events, or
artifacts; no network capability is representable.
