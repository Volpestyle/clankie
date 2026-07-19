# @clankie/gba-emulator

Governed Game Boy Advance emulator embodiment for the `gba_emulator`
environment profile ([ADR 0039](../../docs/adr/0039-gba-emulator-embodiment-and-deterministic-core-boundary.md),
[ADR 0040](../../docs/adr/0040-real-mgba-core-behind-the-emulator-seam.md)).

`GbaEmulatorAdapter` is an `EnvironmentAdapter` dispatched through
`@clankie/environment-runtime`, so every action inherits the runtime's
register-before-dispatch idempotency, runner leases, pause/cancel, and
emergency-stop fencing — the adapter owns no action loop. It validates the
strict emulator contract from `@clankie/interactive-environment`, enforces
per-lease input/frame bounds and capabilities, drives the pinned core, and
records a bounded hash-chained evidence trace.

## The core seam

Two interchangeable cores implement the adapter-facing `GbaCoreSeam` (button
input consuming frames + typed RAM-derived state + framebuffer/RAM digests):

- `DeterministicGbaCoreDouble` — clearly-labeled **test infrastructure, not a
  product simulator**: a controllable, deterministic stand-in anchored on a
  savestate identity digest and an RNG seed. It is the default core, so the
  CI suite and the frozen `verdant-path-trainer-battle` scenario run without
  any ROM.
- `MgbaFireRedCore` — the **real core**: the pinned headless mGBA WASM
  libretro core (`romdev-platform-gba@0.11.0`, MPL-2.0, in-process,
  single-threaded, no network) running an operator-supplied FireRed ROM.
  Creation fails closed unless the ROM, savestate, and core-wasm bytes match
  the SHA-256 digests pinned in the frozen fixture. Observations decode the
  empirically verified EWRAM fields in `firered-ram-map.ts` (overworld
  position + facing in this slice).

## Scenarios

`driveGbaScenario` (double) and `runRealGbaScenario` (real core) are
state-derived drivers: decisions are computed from the latest observations,
change when observed state changes, and uncertain or desynced state pauses the
session and fails closed instead of replaying input. The real route driver's
only memory is the set of directed transitions the emulator itself refused —
observed collision reality that BFS routes around (the FireRed bedroom's
bed-side tile exercises this on the frozen fixture).

The real scenario (`fixtures/firered-bedroom-route/v1`) is ROM-gated: it runs
only when the operator supplies local paths, and CI stays green without them.

```bash
# one-time: regenerate the pinned bedroom savestate from the ROM
CLANKIE_GBA_ROM_PATH=… CLANKIE_GBA_SAVESTATE_PATH=… \
  pnpm --filter @clankie/gba-emulator exec tsx scripts/bootstrap-savestate.ts

# real run: two byte-identical passes + no-network tripwire + evidence capture
CLANKIE_GBA_ROM_PATH=… CLANKIE_GBA_SAVESTATE_PATH=… CLANKIE_GBA_RECEIPT_DIR=… \
  pnpm --filter @clankie/gba-emulator exec tsx scripts/run-real-scenario.ts

# ROM-gated tests join the suite when both paths are set
CLANKIE_GBA_ROM_PATH=… CLANKIE_GBA_SAVESTATE_PATH=… \
  pnpm --filter @clankie/gba-emulator test
```

The adapter is local-only: it performs no network I/O, holds no network or
live-service capability (`GBA_EMULATOR_CAPABILITY_BOUNDARY` cannot represent
one), and rejects all connection/credential material. ROM, BIOS, and savestate
bytes never enter the repository, fixtures, events, or reports — only their
SHA-256 identity digests; image evidence uses bounded `artifact://` frame
references, and screenshots land in the operator's receipt directory.

- `pnpm --filter @clankie/gba-emulator test`
- `pnpm --filter @clankie/gba-emulator fixture:check`
- `pnpm --filter @clankie/gba-emulator scenario:validate [outputDir]`
