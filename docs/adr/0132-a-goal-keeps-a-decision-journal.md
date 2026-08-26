# ADR 0132: A goal keeps a decision journal

Status: accepted (James, 2026-08-26). Extends
[ADR 0130](0130-goals-and-self-wakes-share-the-operator-thread.md) and
[ADR 0107](0107-a-one-shot-turn-still-leaves-a-trail.md).

## Context

Goal pursuit runs across many autonomous continuations and self-wakes. The
conversation's pi trees and lane logs record what Clankie said and did, but
retention prunes conversation directories, and neither trail records what he
*decided* and why while working a goal — which approach he picked, what he
ruled out, what he discarded. A woken turn re-derives choices the last turn
already made, and the owner auditing a finished goal has only the transcript,
if it still exists.

## Decision

Each operator conversation keeps an append-only decision journal beside
`autonomy.json`, one JSONL file per conversation under
`~/.clankie/captain/goal-journal/`. A `note_goal_decision` tool appends one
entry — decision, why, optional evidence pointer — host-stamped with the time,
the owning goal's `createdAt`, and whether the turn was autonomous. `get_goal`
returns the current goal's recent entries, so a continuation or wake starts
from what was already decided instead of re-deriving it.

The journal is Clankie's own account, written by volition: the instructions
ask for a line at real choices, not a protocol that demands one per turn.
Entries survive goal completion and clearing — the journal is the postmortem —
and `recentDecisions` filters to the current goal by its `createdAt`, so an
old goal's entries never masquerade as the new goal's context. The one-writer
rule holds: only the autonomy store touches the journal files.

## Alternatives considered

- Episodes (`remember_episode`): decisions during goal work are status-shaped,
  and the episode ring is deliberately small personality memory; routing goal
  bookkeeping there would evict what the ring exists to keep.
- A host-derived trail: `turn-settled.jsonl` already records tool shapes, but
  "what he decided and why" is model-authored content no host stamp can
  reconstruct.
- A cross-model audit of the trail: a second model grading the journal adds a
  protocol and a verifier identity before there is evidence the owner's own
  read of the journal is not enough.
- A TSV committed into a repository: goals are not repo-scoped; many touch no
  repository at all.

## Consequences

- A goal run can be audited and resumed from its own trail after the
  conversation directory is pruned.
- `get_goal` output grows by the recent journal tail; the full file stays on
  disk for `trace-clankie` reads.
- The TUI `/goal` view does not yet render the journal; the operator reads it
  from disk or through `get_goal`. That surface can follow when wanted.
- An empty journal on a finished goal is itself a signal worth asking about.
