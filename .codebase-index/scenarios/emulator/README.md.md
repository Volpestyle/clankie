# scenarios/emulator/README.md

Explains the frozen GBA scenario discipline:
verdant-path-trainer-battle/v1 is the
deterministic emulator-authoritative scenario for
the gba_emulator profile, with scenario.json
bytes pinned by scenario.sha256 and the binding
repeating that digest.

States what the fixture contains (fictional map/
trainer/party/move state plus determinism
anchors: core id, savestate identity digest, RNG
seed) and what it never contains (ROM, BIOS,
savestate bytes, credentials, screenshots,
packets). Success derives from emulator core
state, a bounded hash-chained evidence trace, and
a state-derived driver decision trace — not
model-authored claims.
