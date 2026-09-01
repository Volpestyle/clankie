# Frozen GBA emulator scenarios

`verdant-path-trainer-battle/v1` is the deterministic emulator-authoritative
scenario for the `gba_emulator` profile. The exact `scenario.json` bytes are
pinned by `scenario.sha256`; the binding repeats that digest and fixes the
gameplay world.

The fixture contains fictional map, trainer, party, and move state plus the
determinism anchors of the pinned core: a core identifier, a savestate
_identity_ digest, and an RNG seed. It never contains ROM, BIOS, or savestate
bytes, account credentials, screenshots, or packets. The scenario derives
success from the emulator core's own final state, a bounded hash-chained
evidence trace, and a state-derived driver decision trace — not from
model-authored claims.
