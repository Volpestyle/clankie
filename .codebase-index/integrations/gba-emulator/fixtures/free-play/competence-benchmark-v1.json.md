# integrations/gba-emulator/fixtures/free-play/competence-benchmark-v1.json

The pinned `firered-free-play-competence`
benchmark: default 8-turn budget, stall
threshold 4, repeated-input limit 4, minimum
accepted-action rate 0.8, ≥3 distinct actions.

States: two `deterministic_double` seeds of
the verdant-path trainer battle (RNG 20260719
/ 20260720, target milestone `battle-won` via
target-tile → dialog → battle) and a
`rom_gated` bedroom-route state (target-tile
milestone). Each state pins scenario id,
version, core id, and savestate digest, so a
run binds to exact identities.
