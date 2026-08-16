# integrations/gba-emulator/scripts/free-play-competence-rom.ts

`createRomCompetenceCoreLoader` — shared
helper for the two competence scripts: reads
the operator's ROM and savestate (env paths or
the well-known game home) once, and returns a
per-state loader that creates a digest-checked
`MgbaFireRedCore` for each ROM-gated benchmark
state. ROM material never gets copied into any
artifact.
