# integrations/gba-emulator/src

The emulator body itself: contracts, three
interchangeable cores behind one seam, the
governed adapter with its composite actions,
deterministic scenario drivers, and the
model-driven free-play loop with journal,
progress tracking, voice, checkpoints, and a
competence benchmark.

Layers, bottom up:

- `mgba-core.ts` — raw libretro driver for the
  pinned mGBA WASM core.
- `firered-ram-map.ts`, `firered-state.ts` —
  version-pinned FireRed RAM/ROM decoders.
- `core-seam.ts` — the `GbaCoreSeam` interface;
  `core-double.ts` (CI test double),
  `firered-core.ts` (real decoded FireRed),
  `visual-core.ts` (framebuffer-only Emerald)
  implement it.
- `adapter.ts` — `GbaEmulatorAdapter`: strict
  contract validation, bounds, hash-chained
  evidence, and the composite actions
  (walk_to / advance_dialog / enter_text /
  select_menu_entry) with BFS pathing and a
  walkability minimap.
- `contracts.ts` — frozen scenario/trace/report
  zod schemas; `driver.ts` + `scenario.ts` run
  the frozen double scenario;
  `real-scenario.ts` the real-core route/rival
  scenario; `live-proof.ts` verifies its
  receipt.
- Free play: `free-play.ts` (turn loop),
  `free-play-mind.ts` (model player + voice),
  `free-play-voice.ts`, `free-play-bounds.ts`,
  `free-play-progress.ts`,
  `free-play-session.ts`, `free-play-boot.ts`,
  `free-play-journal.ts`,
  `free-play-competence.ts`, `checkpoint.ts`,
  `naming-keyboard.ts`.
- Frames: `framebuffer-png.ts`,
  `frame-stream.ts`. `body-lock.ts` re-exports
  the cross-process mutex from
  `@clankie/body-lock`; `index.ts` is the
  barrel.

Everything fails closed: unverified digests,
undecodable RAM, exceeded bounds, and unknown
states are refusals with named reasons, never
guesses.
