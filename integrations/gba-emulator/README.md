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
  pinned to FireRed US v1.0 and derives overworld position/facing, the live map
  collision grid, encrypted party records and legal moves, inventory pockets,
  dialog, start/party/bag menus, and battle input/outcome from EWRAM, IWRAM, and
  the pinned ROM. An unsupported ROM identity, pointer, checksum, value, menu
  state, or battle outcome fails closed.

## Collision

`gBackupMapLayout` (IWRAM `0x03005040`) is FireRed's live map buffer, so walls
are **read rather than remembered**
([ADR 0058](../../docs/adr/0058-read-collision-from-the-live-map-buffer.md)).
Each tile is a `u16`: metatile id in bits 0-9, collision in 10-11, elevation in
12-15.

The buffer carries seven tiles of border filler on every side and that filler
decodes to collision 0, so every query is clamped to the real map and fails
closed outside it — otherwise the void beyond a room's walls reads as open floor.

Collision models walls and nothing else. It does not model ledges, water,
elevation transitions, or NPCs, which occupy tiles without appearing in it. An
open tile means "not a wall", not "reachable on foot", which is why `walk_to`
re-checks every step instead of trusting its own plan.

Warp tiles block *and* transport: the stairs at `(16,9)` in `players-house-2f`
read as a wall, yet pressing into them from `(17,9)` arrives on
`players-house-1f`. So `walk_to` routes within a map and crossing between maps
stays a directional press. Routing through warps would need the map header's
warp-event list decoded too.

## Scenarios

`driveGbaScenario` (double) and `runRealGbaScenario` (core-independent) are
state-derived drivers: decisions are computed from the latest observations,
change when observed state changes, and uncertain or desynced state pauses the
session and fails closed instead of replaying input. The expanded gameplay goal
opens and observes party and bag state, navigates to a trainer, advances
dialog, selects the strongest decoded legal move, and requires a decoded
victory. The route driver also remembers the set of directed transitions the
emulator itself refused, which covers what tile collision does not — NPCs, and
anything else that blocks without being a wall.

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

Play progress persists as minted checkpoints
([ADR 0060](../../docs/adr/0060-progress-as-minted-checkpoints.md)): the
`checkpoint.ts` module captures the serialized core state into an
operator-local directory with a digest receipt and a companion scenario that
boots through this same fail-closed loader. The pinned fixtures stay frozen — a
checkpoint is always a sibling identity, never an overwrite — and loading
verifies the id, receipt, ROM, core build, and savestate digest before touching
the core. The GBA MCP server publishes this as lease-gated
`gba_emulator_save_state` / `gba_emulator_load_state` tools.

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

## Free play (ADR 0049)

`pnpm gba:free-play` runs a **model**, not an algorithm. The scenario drivers
above compute every action — `nextRealRouteStep` is BFS, move selection is an
`argmax` — and stay deterministic. Free play hands the decision to Clankie.

```bash
CLANKIE_FREE_PLAY_TURNS=20 pnpm gba:free-play
```

Each turn he receives the decoded state, returns a bounded `monologue` and
`intent` alongside one catalogued action, and the CLI prints the playthrough as
readable text. Actions dispatch through `EnvironmentRuntime` exactly as scripted
ones do, so an illegal choice is refused by the same machinery.

Failure is a turn outcome, never an exception: `rejected_by_adapter`,
`invalid_decision`, and `mind_failed` are all recorded and the run continues.

The run reports **coherence** — how often the previous turn's stated intent
referenced the action actually taken. It separates reasoning from post-hoc
narration and is a keyword heuristic over free text, so it is reported and never
gated.

Runs against the core double with no ROM. The trace is written under
`artifacts/` and stays untracked because it carries model monologue; a six-turn
format sample lives in `fixtures/free-play/sample-trace.jsonl`.
