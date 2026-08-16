# integrations/gba-emulator

`@clankie/gba-emulator` — Clankie's Game Boy
Advance body. A governed emulator adapter
drives one of three interchangeable cores
behind the `GbaCoreSeam`: a deterministic CI
test double, the real headless mGBA WASM core
decoding Pokémon FireRed US v1.0 RAM, or a
framebuffer-only "visual" core for Emerald.

Children:

- `src/` — adapter, cores, FireRed RAM
  decoders, scenario drivers, free-play loop,
  checkpoints, frame streaming.
- `scripts/` — CLI entrypoints: free play,
  live-proof runs, receipt evaluators,
  savestate bootstrap, RAM probe.
- `test/` — vitest suites (ROM-gated ones join
  only when ROM env vars are set).
- `fixtures/` — pinned scenario JSON (digests
  only, never ROM/savestate bytes).
- `README.md` — the package's own deep guide.
- `package.json` — workspace package metadata and scripts.
- `tsconfig.json` — TypeScript project config.

Key ideas: every action is validated against
the strict emulator contract and per-lease
input/frame bounds; evidence is a bounded
hash-chained trace (frozen policy for
receipts, rolling for open-ended play);
composite actions (`walk_to`,
`advance_dialog`, `enter_text`,
`select_menu_entry`) make one model turn out
of what used to cost dozens of presses; and
free play hands each decision to a model —
the mind — with a separate voice agent for
speech plus a bounded journal story projection.
Collision, exits, and menus are read
live from FireRed RAM at empirically verified
addresses, failing closed on anything the
decoders cannot trust.
