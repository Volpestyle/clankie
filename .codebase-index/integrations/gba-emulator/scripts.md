# integrations/gba-emulator/scripts

CLI entrypoints (tsx, wired to package.json
scripts). One file per operator job:

- `free-play-cli.ts` — `pnpm gba:free-play`:
  watch Clankie play by his own choices.
- `run-real-scenario.ts` — the ROM-gated
  two-run byte-identical live proof with a
  no-network tripwire.
- `evaluate-live-receipt.ts` — re-verify an
  existing live-proof receipt.
- `run-free-play-competence.ts` /
  `evaluate-free-play-competence-receipt.ts` —
  the competence benchmark and its evaluator.
- `free-play-competence-rom.ts` — shared
  operator ROM loader for the two above.
- `bootstrap-savestate.ts` — regenerate the
  pinned bedroom savestate from a ROM with a
  frozen input schedule.
- `probe-fire-red.ts` — bounded operator-local
  RAM/frame probe for fixture development.
- `check-fixture.ts` / `validate-scenario.ts`
  — frozen-fixture integrity and a full
  double-scenario evidence run.
- `png-writer.ts` — tiny shared PNG file
  writer.

All ROM-touching scripts take operator paths
via `CLANKIE_GBA_*` env vars and write
evidence outside the repository; ROM and
savestate bytes never land in any output.
