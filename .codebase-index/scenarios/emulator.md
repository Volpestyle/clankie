# scenarios/emulator

Frozen GBA emulator scenarios for the
gba_emulator environment profile. Holds a README
on the freeze discipline and one scenario,
verdant-path-trainer-battle/v1 — a deterministic,
emulator-authoritative trainer-battle fixture
whose scenario.json bytes are pinned by
scenario.sha256 and repeated in binding.json.

Success comes from the emulator core's own final
state, a bounded hash-chained evidence trace, and
a state-derived decision trace. The fixture is
entirely fictional game data plus determinism
anchors (core id, savestate identity digest, RNG
seed) — never ROM, BIOS, or savestate bytes.
