# ADR 0060: Progress survives as minted checkpoints, never a mutated identity

Status: accepted (James, 2026-07-25). Implemented in the GBA emulator
integration and the GBA MCP server, with the fail-closed paths covered by
tests.

## Context

Every boot of the real core loads the one pinned savestate and verifies it
against the digest its scenario fixture pins, failing closed on mismatch. That
is the determinism model working as designed — and it also meant a play
session's progress was structurally unsaveable. Nothing called the core's
serializer during play, the in-game save wrote to flash that only existed in
process RAM, and the next boot restored the bedroom regardless.
[ADR 0059](0059-lease-expiry-pauses-the-body.md) closed with exactly this
loose end: world state does not survive process death, and durable progress
across restarts was "a separate, undecided concern."

The naive fix — write the current state over the configured savestate — would
break the model it lives inside: the fixture's digest would no longer match,
and "the pinned savestate" would quietly stop meaning anything.

## Decision

### A save mints a sibling identity

`writeGbaCheckpoint` captures the serialized core state into an operator-local
checkpoint directory alongside two documents:

- a **receipt** recording the checkpoint id, optional label, capture time,
  overworld position, and the digests of the savestate, ROM, and core wasm the
  running core verified at boot;
- a **companion scenario** — the booted route scenario with only its savestate
  identity replaced (`savestateId: checkpoint:<id>`, the new digest). It parses
  under the same schema and boots through the same fail-closed loader, so a
  checkpoint is a first-class pinned identity, not an exception to the rule.

The pinned fixtures stay frozen. Nothing ever overwrites an existing identity;
a checkpoint is always a new sibling. Savestate bytes stay operator-local
exactly like the ROM — receipts, evidence, and tool results carry digests only.

### A load verifies everything before touching the core

`readGbaCheckpoint` refuses ids that are not directory basenames, receipts that
do not name their own directory, checkpoints taken from a different ROM or core
build, and savestate bytes that fail their recorded digest. Only then does the
core restore, resetting its derived battle bookkeeping — that bookkeeping
described the replaced timeline. Logical frame and input counters keep
counting: they order evidence within the process run, and restoring RAM does
not rewind what already happened here.

### Save and load are driving

The MCP surface publishes both as lease-gated tools. `gba_emulator_save_state`
captures the body's complete state — more than observation exposes — and
`gba_emulator_load_state` rewrites the body's whole world, so both are gated by
possession exactly like acting ([ADR 0053](0053-mcp-possession-of-clankies-body.md)).
Load with no id lists what exists instead of guessing. Both are absent on the
deterministic double, whose determinism *is* its identity: there is no state to
serialize that the scenario does not already pin.

## Consequences

- Hours of unreplayable free play ([ADR 0049](0049-free-play-agency-and-non-deterministic-evidence.md))
  can now outlive the process: save a checkpoint, and a later boot points
  `CLANKIE_GBA_SAVESTATE_PATH` and `CLANKIE_GBA_SCENARIO_PATH` at the
  checkpoint's pair. Mid-session, a possessor can restore without restarting.
- The determinism anchors hold. Session specs bind to whatever scenario booted
  them, checkpoint or fixture, through the unchanged `validateScenarioBinding`.
- The companion scenario's route fields (map, start, target) describe the
  original fixture's route, not where the checkpoint was taken; the receipt
  records the actual position. A checkpoint scenario is a boot anchor, not a
  route to replay — running the deterministic route drivers from one is not a
  supported use.
- Evidence emitted after a mid-session load still cites the boot savestate in
  its determinism anchors, which stays true — that is where this session
  started. The load itself is visible in the tool result and the watchers'
  frame stream.
