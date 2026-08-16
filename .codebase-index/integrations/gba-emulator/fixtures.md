# integrations/gba-emulator/fixtures

Pinned scenario fixtures — identity digests
and bounds only, never ROM or savestate bytes.
Each `<name>/v1/scenario.json` is a frozen,
versioned identity; a new state is a new
sibling, never an overwrite.

- `firered-bedroom-route/` — the default real
  scenario: a bounded bedroom walk.
- `firered-oaks-lab-rival/` — party/bag proof,
  lab route, rival starter battle.
- `emerald-title/` — the framebuffer-only
  Emerald pin (asked play's cartridge).
- `free-play/` — the competence benchmark
  definition and a six-turn trace format
  sample.

The frozen double scenario itself lives
outside the package at
`scenarios/emulator/verdant-path-trainer-battle/`.
