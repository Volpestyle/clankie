# ADR 0061: Evidence rolls for open-ended play; only receipts freeze

Status: accepted (James, 2026-07-26). Implemented in the GBA adapter and the
free-play session composer, with both policies covered by tests.

## Context

A possession-driven FireRed session died mid-starter-selection with
`severity: high, code: uncertain_state — Bounded evidence capacity is
exceeded`, and nothing recovered it: not pause/resume, not releasing and
re-possessing, not waiting. The adapter session records hash-chained evidence
per action into a window bounded by the scenario's `maxEvidenceEvents` (≤256,
sized for frozen scenario runs), and on overflow it marks the state uncertain —
permanently, because nothing resets `certain`. A marathon session is guaranteed
to hit this: the cap fires at a fixed count of actions, not at any actual
uncertainty about the game state.

The bound itself is correct for what it is built for. A **receipt** run — the
frozen deterministic scenarios with their byte-identical two-core replays — is
_supposed_ to be invalid when it exceeds its evidence budget; that is the
fail-closed evidence model doing its job. The bug is applying receipt rules to
open-ended play, where [ADR 0049](0049-free-play-agency-and-non-deterministic-evidence.md)
already accepts that no run reproduces another and evidence is per-turn, not a
sealed whole.

## Decision

The adapter gains an evidence policy, chosen where the session is composed:

- **`frozen`** (default): exactly the old behavior. Overflow marks the state
  uncertain and refuses further actions. Every deterministic scenario driver
  keeps this policy, and frozen receipts stay byte-identical — a trace that
  never rolls carries no new fields.
- **`rolling`** (what `createFreePlaySession` uses): when the window fills, it
  is sealed and a fresh window starts. The within-window hash chain restarts
  from genesis — the evidence event schema itself caps `sequence` at the
  window size, so every window is independently a valid chain — and the trace
  carries `rolledWindows` and `droppedEvidenceEvents`, so the cap is confessed
  rather than silent (the no-silent-caps rule).

The body never stops because a ledger filled. Uncertainty remains reserved for
actual uncertainty about state.

## Consequences

- Marathon possession and free-play sessions have no hidden ~256-action
  fuse. The trace still bounds memory: at most one window of events is retained.
- A rolling trace is a **window onto** the run, not a receipt **of** the run —
  its `rolledWindows`/`droppedEvidenceEvents` fields say so explicitly, and
  receipt evaluation is unaffected because receipt runs never roll.
- A session wedged by the old behavior is recoverable without losing the world:
  `gba_emulator_save_state` reaches the core directly rather than through the
  adapter, so a checkpoint can be minted even from an uncertain session
  ([ADR 0060](0060-progress-as-minted-checkpoints.md)), then restored into a
  fresh server.
