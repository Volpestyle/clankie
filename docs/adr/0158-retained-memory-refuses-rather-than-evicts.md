# ADR 0158: Retained memory refuses rather than evicts

Status: proposed (2026-09-04). Extends
[ADR 0054](0054-cross-lane-presence-and-episodic-self-memory.md).

## Context

Clankie's episodes were one global ring of 128 across every lane, with the
newest eight rendered automatically into each run's system prompt. The ring is
the right shape for ambient recall — it stays small, it costs nothing to read,
and it cannot grow into the prompt. It is the wrong shape for a life. A busy
gameplay session ages out a decision made at the console a week earlier, and
the memory is not merely out of the card: it is gone from disk.

So there are two different needs sharing one store. Ambient recall wants a
small recent window that ages. Continuity wants specific experiences and
decisions to survive any number of busy rooms and any number of restarts.

## Decision

An episode carries a `retained` flag, and the flag decides which bound it
answers to. Unretained notes keep the 128-entry global ring exactly as before.
Retained notes are held outside it, up to a ceiling of 1024 across every lane.

**The retained ceiling is a ceiling, not a ring.** At capacity, the next retain
is refused with a message naming the capacity, and every record already kept is
left untouched. Releasing or forgetting one makes room. Deciding a memory is
worth keeping is Clankie's, and the operator's; a bound that quietly un-keeps
the oldest kept memory would turn that decision into a lie the moment it
mattered. A refusal on a write refuses the keeping, not the remembering — the
note still lands in the recent window, and the tool result reports
`retained: false` with the reason, so he never believes he kept something he
did not.

Recall stays two shapes over one store. The automatic card remains the newest
eight visible episodes; `recall_episodes` searches everything on demand. Search
is a scan — every term must appear in the note or the room it happened in,
newest first — over the same lane visibility filter the card uses, so an
operator-private memory cannot surface in a Discord or gameplay search.

Correction supersedes in place. `remember_episode` with `corrects` replaces the
named note and stamps `correctedAt`, never rewriting its room, its date, or its
provenance.

**Reading a memory is not authority to rewrite it.** A correction requires both
read visibility and authorship: the operator lane may correct anything, every
other lane only what it wrote itself. `shareable` is the ordinary case, so a
visibility check alone would leave every console-authored note rewritable from
any room — and model output is untrusted input. The same boundary applies to
recording: `recordEpisode` only ever adds, so a write landing on an existing id
is a conflict rather than an upsert, and a bearer that may author its own room
cannot delete a memory it could never correct by re-declaring that memory's id.
A bearer authors only the lane it serves; the body naming a lane does not make
it one.

Search answers with the same rendered card the recent branch does, never with
episode records, so no lane reads provenance ids its sibling branch withholds.

## Consequences

- One record per memory. Retaining does not copy, so forgetting reaches the
  recent and kept views at once and a correction is a correction everywhere.
- `retained` and `correctedAt` are optional with defaults, so every episode
  written before this loads unchanged and unretained. Retention is not
  retroactive: an episode the ring evicted before it was retained is gone, and
  nothing can bring it back.
- A full shelf is a state the operator has to resolve, not one the store
  resolves for them. `clankie memory status`, `/memory status`, and the catalog
  carry the retained count and capacity so it is visible before it bites.
- Search is O(store) per call. At 1152 episodes with a 512-character cap that is
  a trivial scan; an index or an embedding is a dependency to buy when the
  requirement actually arrives, not before.
- The durable set is bounded by refusal rather than by disk, so memory cannot
  grow without someone choosing it.
