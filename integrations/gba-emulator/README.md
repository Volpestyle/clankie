# @clankie/gba-emulator

Governed Game Boy Advance emulator embodiment for the `gba_emulator`
environment profile ([ADR 0039](../../docs/adr/0039-gba-emulator-embodiment-and-deterministic-core-boundary.md),
[ADR 0040](../../docs/adr/0040-real-mgba-core-behind-the-emulator-seam.md),
[ADR 0043](../../docs/adr/0043-version-pinned-firered-gameplay-profile.md),
[ADR 0090](../../docs/adr/0090-emerald-plays-from-the-screen.md)).

`GbaEmulatorAdapter` is an `EnvironmentAdapter` dispatched through
`@clankie/environment-runtime`, so every action inherits the runtime's
register-before-dispatch idempotency, leases, pause/cancel, and
emergency-stop fencing — the adapter owns no action loop. It validates the
strict emulator contract from `@clankie/interactive-environment`, enforces
per-lease input/frame bounds and capabilities, drives the pinned core, and
records a bounded hash-chained evidence trace.

This package implements a body; it is not a shared body service. Clankie's play
host and each GBA MCP process instantiate independent cores, runtimes, sessions,
and checkpoint scopes. The runtime's internal session/capability lease fences
its owner's actions and recovery; it does not let one process possess another
([ADR 0129](../../docs/adr/0129-each-player-owns-a-body.md)).

## The core seam

Three interchangeable cores implement the adapter-facing `GbaCoreSeam` (button
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
  dialog, start/party/bag menus, the HELP overlay, the naming screen (typed
  text, keyboard page, and what is being named), and battle input/outcome from
  EWRAM, IWRAM, and the pinned ROM. An unsupported ROM identity, pointer,
  checksum, value, menu state, or battle outcome fails closed.
- `MgbaVisualCore` — the same real, pinned mGBA body for Pokémon Emerald
  BPEE rev 0, booted from an operator-local digest-pinned title savestate. It
  exposes the real framebuffer, raw buttons, RAM digest, and checkpoints. Until
  Emerald has its own verified RAM profile, decoded observations and composite
  actions fail closed; the free-play mind plays from the screen with raw input.

Both real-core facades use `MgbaLibretroCore`'s single frame pump: one observed
frame per emulated frame, deadline-paced at the calibrated 59.7275 Hz without
blocking the event loop. Idle ticks stand off while that pump owns an action.

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

Warp tiles can block _and_ transport: the stair graphic at `(16,9)` in
`players-house-2f` reads as a wall, while the warp event beside it at `(17,9)`
is stood on and pressed toward. `walk_to` still routes within a map and a
mid-route warp still ends the route, but a `walk_to` aimed at a decoded warp
tile on blocking collision — an outdoor door — routes to a tile beside it and
presses in ([ADR 0089](../../docs/adr/0089-the-map-is-his-to-read.md)).

## Exits and the minimap

`gMapHeader` (EWRAM `0x02036DFC`) is decoded for the loaded map's warp events
and edge connections ([ADR 0089](../../docs/adr/0089-the-map-is-his-to-read.md)),
verified by the same scan-and-sole-survivor method as the map buffer and
cross-checked against known doors, stairs, and pallet-town's Route 1 edge. The
overworld observation reports them as `exits` (each warp in player coordinate
space with its destination map id, each connection as a direction and
destination) and renders a `minimap`: a crop of the collision grid around the
player — `@` player, `.` open, `#` blocked, `D` warp — with `topLeft` naming
the crop's origin so any cell converts to a `walk_to` target. Refused walks
classify (`walk_target_outside_map`, `walk_target_impassable`,
`no_path_to_target`) and name the map's bounds or the nearest reachable open
tile. Absence stays absence: no loaded map, or a header the decoder cannot
trust, reports null rather than a guess.

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
The `fixtures/emerald-title/v1` scenario pins the Emerald ROM, title savestate,
and core identities. Asked play discovers its operator-local bytes as
`~/.local/share/clankie/gba/emerald.gba` and `emerald-title.state`.

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

Free-play sessions use the **rolling evidence policy**
([ADR 0061](../../docs/adr/0061-evidence-rolls-for-open-ended-play.md)): when
the bounded evidence window fills, it is sealed and a fresh one starts, with
the roll counted in the trace — open-ended play never dies at a receipt-sized
cap. The deterministic scenario drivers keep the frozen policy, where
exceeding the budget is invalid evidence and fails closed.

Play progress persists as minted checkpoints
([ADR 0060](../../docs/adr/0060-progress-as-minted-checkpoints.md)): the
`checkpoint.ts` module captures the serialized core state into an
operator-local directory with a digest receipt and a companion scenario that
boots through this same fail-closed loader. The pinned fixtures stay frozen — a
checkpoint is always a sibling identity, never an overwrite — and loading
verifies the id, receipt, ROM, core build, and savestate digest before touching
the core. The GBA MCP server publishes this behind its private runtime lease as
`gba_emulator_save_state` / `gba_emulator_load_state` tools.
Asked play exposes the same store as Clankie's `save_checkpoint` and
`load_checkpoint` choices, carrying his current notes and objective into every
explicit save. The local TUI's `/saves` browser lists and explicitly deletes
receipt-validated checkpoints; hosted-world cartridge persistence remains server-owned.

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

## Free Play

[ADR 0049](../../docs/adr/0049-free-play-agency-and-non-deterministic-evidence.md)
defines free-play agency.

`pnpm gba:free-play` runs a **model**, not an algorithm. The scenario drivers
above compute every action — route callers provide their own direction order
and edge rules to one bounded BFS, while move selection is an `argmax` — and
stay deterministic. Free play hands the decision to Clankie.

```bash
CLANKIE_FREE_PLAY_TURNS=20 pnpm gba:free-play
```

Each turn he receives the decoded state, returns a bounded `monologue` and
`intent` alongside one catalogued action, and the CLI prints the playthrough as
readable text. Actions dispatch through `EnvironmentRuntime` exactly as scripted
ones do, so an illegal choice is refused by the same machinery.

A conversation is one turn, not one per text box: `advance_dialog` reads to the
next real decision point and hands back the transcript
([ADR 0066](../../docs/adr/0066-dialog-is-one-action-not-one-press-per-box.md)).
The text he read arrives as that turn's observed effect, because the boxes are
gone by the time the next turn looks at the screen. It also enters the states
he reaches for it in: a script-held box (a fanfare) is waited out, and battle
text reads like dialog, stopping at his action menu
([ADR 0072](../../docs/adr/0072-the-harness-tells-him-the-truth.md)).

A name is one turn too: `enter_text` drives the naming-screen keyboard from
its decoded cursor state — verified key by key against the live buffer — and
confirms with OK. A room is one turn: `walk_to` is on his action vocabulary
alongside the presses. A menu choice is one turn: `select_menu_entry` walks
the cursor to the entry he named and confirms it, verified press by press
([ADR 0073](../../docs/adr/0073-a-menu-choice-is-one-action-not-one-press-per-cursor-step.md))
— which entry stays entirely his decision.

His saved time is his too ([ADR 0075](../../docs/adr/0075-rewinding-is-a-play-choice.md)):
`load_checkpoint` lists or restores minted checkpoints and `restart_game`
reboots to the configured beginning, both dispatched to an injected checkpoint
port rather than the frozen emulator catalog. The present is banked as a
`before-rewind` checkpoint before either, so the choice destroys nothing, and
his notes ride across the jump — the world rewinds, the mind does not.

Failure is a turn outcome, never an exception: `rejected_by_adapter`,
`invalid_decision`, and `mind_failed` are all recorded and the run continues —
and the refusal reason is the turn's effect, so a rejected action reads
as the refusal it is, never as a fabricated result (ADR 0072). A `scene`
observation carries `mode`, `inputReady`, and `waitingForDialogAdvance`, so a
scripted hold or an undecoded screen announces itself instead of masquerading
as a stuck overworld.

An effect is two fields, because it has two readers (ADR 0108). `effect` is the
observation — what changed — and it is the half every audience gets: the
activity overlay, the story card, and the play voice seam that hands a voice
room what just happened. `effectAdvice` is the harness coaching his next press
("hold the direction longer to move", "steer this menu with single presses"),
written to him in the imperative and joined onto the effect only in the history
the mind reads. Coaching in an audience's line is how he came to sound like he
was directing the room through a game nobody else was playing.

The run reports **coherence** — how often the previous turn's stated intent
referenced the action actually taken. It separates reasoning from post-hoc
narration and is a keyword heuristic over free text, so it is reported and never
gated.

Recent turn history remains capped at eight, while successful map transitions
live in a separate bounded session memory as observed source/action/destination
facts ([ADR 0116](../../docs/adr/0116-learned-transitions-and-stale-objectives-are-bounded-facts.md)).
The loop also reports recurring semantic states across varied actions. A standing
objective is optional (`null` clears it); after two warned decisions where the
same old objective and recurring states persist, the loop retires the objective
without choosing its replacement or the next action. Hosted walks with no route
detail are described from verified before/after positions, never from transport
input counts.

### Free-play competence gate

`pnpm --filter @clankie/gba-emulator gameplay:competence -- --mode deterministic_double` runs two pinned ROM-free
seeds through a state-derived controller and requires objective milestones,
turn-budget efficiency, distinct accepted actions, and no unresolved stall.
A repeat-only controller fails even when the adapter accepts every press.

The operator-local real-core row uses the same evaluator and writes no game or
model content:

```bash
CLANKIE_GBA_COMPETENCE_RECEIPT_DIR=/operator/evidence/free-play \
  pnpm --filter @clankie/gba-emulator gameplay:competence -- --mode rom_gated

CLANKIE_GBA_COMPETENCE_RECEIPT_PATH=/operator/evidence/free-play/free-play-competence-receipt.json \
  pnpm --filter @clankie/gba-emulator gameplay:evaluate-competence-receipt
```

The receipt binds each run to its actual deterministic fixture or
ROM/savestate/core hashes and contains only milestone, action-efficiency, and
stall metrics. Evaluation loads the canonical benchmark independently,
recomputes the checks, requires the exact ROM-gated state set and identities,
and reruns that state on a fresh operator-local core before matching the new
report to the stored one. “Optimal” means repeatable milestone progress within
the pinned budget without repeat-only input or unresolved stalls; it does not
claim a globally optimal route or speedrun.

Runs against the core double with no ROM. The trace is written under
`artifacts/` with a per-run filename (so runs never overwrite each other) and
stays untracked because it carries model monologue; a six-turn format sample
lives in `fixtures/free-play/sample-trace.jsonl`.

## Asked Play

[ADR 0063](../../docs/adr/0063-a-play-request-starts-embodiment.md) defines the
product entry into play.

The product entrance to free play is an ask: a captain turn submits an
embodiment intent, the service's play host claims it, and this package's
composition — `createFreePlaySession`, `runFreePlay`, and checkpoints — runs
inside Clankie's service instead of a hand-launched terminal. `RunFreePlayInput`
takes a `shouldStop` hook so an asked stop or an exhausted duration budget ends
the playthrough at a turn boundary, and an asked session resumes from the
newest compatible checkpoint and mints one on the way out (ADR 0060).
`pnpm gba:free-play-live` remains the development alias of the same composition
([`apps/clankie/src/play-execution.ts`](../../apps/clankie/src/play-execution.ts)).

Every run leaves a durable trail (ADR 0068). `openFreePlayJournal` writes one
append-only JSONL per run under `~/.local/state/clankie/gba-play/`: a header,
every validated `FreePlayTurn` with its V2 causal evidence packet, then a summary
with progress, volition, coherence, exact-repeat, semantic-recurrence, and
objective-retirement metrics. Selected turns and the terminal summary reference
hashed native-resolution PNGs under `.screenshots/<journal-stem>/`. Capture is
bounded to the first turn, 25-turn intervals, map/scene/objective transitions,
noteworthy speech-intent turns, failures, and the terminal frame, with no more
than 64 screenshots per run. V1/V2 journals remain readable. V3 headers bind
each run to a stable journey, environment, and venue. The journey projection
combines those runs into the bounded story returned by `pokeagent_recall` and
restores the last notes/objective on a cold local start or hosted-world return
([ADR 0126](../../docs/adr/0126-game-state-history-and-memory-have-separate-owners.md)).
Each run also has its own
environment session identity (`gba-free-play:<scenario>:v<n>:<run-stamp>`), so
a new playthrough never overwrites the previous run's session record; the
record itself is a bounded working set under `EnvironmentRuntimeRetention`
(newest 128 action outcomes, rolled with a count; newest 16 ended records),
because the journal, not the runtime's operational state, is the full history.

Evaluate a journal offline as JSON:

```bash
pnpm --filter @clankie/gba-emulator gameplay:evaluate-journal -- \
  ~/.local/state/clankie/gba-play/<run>.jsonl
```

The CLI resolves lifecycle events through `CLANKIE_EVENT_LOG`, then
`CLANKIE_STATE/events.jsonl`, then `~/.clankie/events.jsonl`. Voice receipts use
`DISCORD_BRIDGE_RECEIPT_PATH`, then the normal `XDG_STATE_HOME` location.
`--events` and `--voice-receipts` take final precedence. Missing implicit
defaults are optional; an explicitly named path must exist. The report includes
per-turn causal evidence and conservative verdicts plus aggregate timing,
outcomes, alignment, movement, scene appropriateness, stalls, recovery,
narration receipts, and terminal accounting. Missing V1, stage, or receipt
evidence remains `unknown`. Journal JSONL never contains PNG, PCM, credentials,
media bytes, the full room transcript, or generated voice wording; screenshot
bytes live only in the bounded sibling artifact directory, and exact audible
wording remains unknown by policy.
