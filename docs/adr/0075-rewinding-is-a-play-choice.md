# 0075. Rewinding is a play choice

Date: 2026-08-01
Status: accepted (owner decision)

## Context

Free play includes restarting from the beginning or loading any verified
checkpoint. A GBA soft reset is a four-button chord that `button_press` cannot
express, while the checkpoint capability provides verified state restoration
([ADR 0060](0060-progress-as-minted-checkpoints.md)). The free-play loop exposes
rewind as a model-decided body action.

Two facts make the grant safe to give:

- **Checkpoints are append-only sibling identities** (ADR 0060). Loading an
  old state destroys nothing that is minted.
- **The present can be banked mechanically before every rewind**, closing the
  one gap — live RAM progress since the last mint — that a load could lose.

## Decision

The free-play decision has three loop-owned body actions: `save_checkpoint`
(mint the current world and mind with an optional label), `load_checkpoint`
(`checkpointId` absent = list what exists; present = restore it), and
`restart_game` (reboot to the configured starting savestate).

- **They live outside the frozen emulator catalog.** ADR 0060 defines state
  loads as hooks beside the action surface, so the loop dispatches them to an injected
  `FreePlayCheckpointPort`, `GbaEmulatorActionSchema` and the environment
  runtime do not change, and a body composed without the port (the
  deterministic double, play-only tests) refuses truthfully.
- **Every rewind banks the present first.** The port mints a `before-rewind`
  checkpoint — carrying his current notes and objective as continuity — before
  restoring anything, so his own choice can never destroy the state it leaves.
  A refused load (unknown id, digest mismatch, foreign ROM) is verified
  _before_ the bank and mints nothing.
- **An explicit save carries the current mind.** The body action passes the
  current notes, objective, and decoded position to the same
  `writeGbaCheckpoint` gate used by autosave and clean stop. It creates a new
  sibling and never mutates an earlier save.
- **The world rewinds; his mind does not.** Notes, objective, history, and
  refusal memory stay untouched across a load — he remembers deciding to
  rewind, and what he knew. The restored checkpoint's own continuity is not
  forced over his notes; the effect line reports what is restored and his
  memory stays his to rewrite.
- **The load gates stay.** The port loads through `readGbaCheckpoint`
  unchanged: identity, digest, and basename checks all still refuse, and the
  refusal reason is the turn's effect (ADR 0072).
- **"The beginning" is the configured boot savestate.** The configured default is the
  pinned bedroom start; the boot bytes are held from the digest-verified boot
  and restored without re-reading the operator's file. A true new-game
  beginning (Oak's intro, the naming screen) is the same action pointed at a
  different pinned savestate — the operator captures one and configures it;
  no code changes.
- The prompt states the capability in his-choice terms and never suggests
  using it: what to rewind, and whether to, is volition, not guidance —
  the same rule the speak surface follows.

## Consequences

- The asked-play runner composes the port from its checkpoint directory and
  boot capability (`GbaCheckpointCapability.bootSavestate`); each rewind and
  each bank is logged with its checkpoint id.
- A listing costs a turn and answers inside the action's effect, mirroring
  the MCP load tool's no-id shape — checkpoints are not pushed into every
  turn's view.
- Checkpoint volume grows through Clankie's explicit saves, one
  `before-rewind` mint per rewind, autosaves, and stop mints. Nothing prunes
  them automatically. The TUI's `/saves` browser gives the operator an explicit
  confirmed deletion path.
- The MCP possession surface is unchanged: possessors already hold load/save,
  and gain nothing new here. If a possessor ever needs a boot restart, that is
  a separate small addition.
- An external stop remains an external stop. Nothing here lets him refuse an
  asked stop, extend a session, or touch the body lock — the rewind is inside
  the same session every other action is.
