# integrations/gba-emulator/scripts/run-free-play-competence.ts

`gameplay:competence` — runs the free-play
competence benchmark
(`fixtures/free-play/competence-benchmark-v1.json`)
in `deterministic_double` (default),
`rom_gated`, or `all` mode via `--mode` /
`CLANKIE_GBA_COMPETENCE_MODE`.

ROM-gated modes require
`CLANKIE_GBA_COMPETENCE_RECEIPT_DIR` and write
the full report plus the content-free operator
receipt there (mode 0600). Prints a bounded
JSON summary and exits 1 on failure.
