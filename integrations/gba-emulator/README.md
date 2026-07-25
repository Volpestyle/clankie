# @clankie/gba-emulator

Governed Game Boy Advance emulator embodiment for the `gba_emulator`
environment profile ([ADR 0039](../../docs/adr/0039-gba-emulator-embodiment-and-deterministic-core-boundary.md),
[ADR 0040](../../docs/adr/0040-real-mgba-core-behind-the-emulator-seam.md),
[ADR 0043](../../docs/adr/0043-version-pinned-firered-gameplay-profile.md)).

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
  the SHA-256 digests pinned in the selected fixture. The gameplay decoder is
  pinned to FireRed US v1.0 and derives overworld position/facing, encrypted
  party records and legal moves, inventory pockets, dialog, start/party/bag
  menus, and battle input/outcome from EWRAM, IWRAM, and the pinned ROM. An
  unsupported ROM identity, pointer, checksum, value, menu state, or battle
  outcome fails closed.

## Scenarios

`driveGbaScenario` (double) and `runRealGbaScenario` (core-independent) are
state-derived drivers: decisions are computed from the latest observations,
change when observed state changes, and uncertain or desynced state pauses the
session and fails closed instead of replaying input. The expanded gameplay goal
opens and observes party and bag state, navigates to a trainer, advances
dialog, selects the strongest decoded legal move, and requires a decoded
victory. The route driver's only navigation memory is the set of directed
transitions the emulator itself refused — observed collision reality that BFS
routes around.

The default real scenario (`fixtures/firered-bedroom-route/v1`) is a bounded
bedroom route. The `fixtures/firered-oaks-lab-rival/v1` scenario opens and
observes the party and bag, follows the verified lab route, advances the rival
dialog, and wins the starter battle. Select it through
`CLANKIE_GBA_SCENARIO_PATH` with the operator-local savestate matching its
digest. Both fixtures are ROM-gated. CI runs the complete
menu/dialog/battle decision loop against the clearly labeled core double and
stays green without copyrighted bytes; the rival fixture also produces a
two-fresh-core, byte-identical live receipt with the network tripwire armed.

```bash
# one-time: regenerate the pinned bedroom savestate from the ROM
CLANKIE_GBA_ROM_PATH=… CLANKIE_GBA_SAVESTATE_PATH=… \
  pnpm --filter @clankie/gba-emulator exec tsx scripts/bootstrap-savestate.ts

# real gameplay run: two byte-identical passes + no-network tripwire + evidence capture
CLANKIE_GBA_ROM_PATH=… CLANKIE_GBA_SAVESTATE_PATH=… CLANKIE_GBA_RECEIPT_DIR=… \
CLANKIE_GBA_SCENARIO_PATH=… \
  pnpm --filter @clankie/gba-emulator gameplay:live-proof

# re-verify existing operator-local evidence without reopening ROM/savestate bytes
CLANKIE_GBA_LIVE_RECEIPT_PATH=… \
  pnpm --filter @clankie/gba-emulator gameplay:evaluate-receipt

# ROM-gated tests join the suite when both paths are set
CLANKIE_GBA_ROM_PATH=… CLANKIE_GBA_SAVESTATE_PATH=… \
  pnpm --filter @clankie/gba-emulator test
```

Fixture development uses the bounded operator-local probe. Its JSON input list
applies no more than 256 button presses and writes only decoded state,
digests, a screenshot, and an optional next savestate outside the repository:

```bash
CLANKIE_GBA_ROM_PATH=… CLANKIE_GBA_SAVESTATE_PATH=… \
CLANKIE_GBA_PROBE_OUTPUT_DIR=… \
CLANKIE_GBA_PROBE_INPUTS='[{"button":"start","holdFrames":8,"settleFrames":32}]' \
  pnpm --filter @clankie/gba-emulator probe:firered
```

The adapter is local-only: it performs no network I/O, holds no network or
live-service capability (`GBA_EMULATOR_CAPABILITY_BOUNDARY` cannot represent
one), and rejects all connection/credential material. ROM, BIOS, and savestate
bytes never enter the repository, fixtures, events, or reports — only their
SHA-256 identity digests; image evidence uses bounded `artifact://` frame
references, and screenshots land in the operator's receipt directory. Receipt
evaluation rejects symlinks and recomputes the report, decision, event,
semantic-event, and screenshot hashes before accepting existing evidence.

- `pnpm --filter @clankie/gba-emulator test`
- `pnpm --filter @clankie/gba-emulator fixture:check`
- `pnpm --filter @clankie/gba-emulator scenario:validate [outputDir]`
