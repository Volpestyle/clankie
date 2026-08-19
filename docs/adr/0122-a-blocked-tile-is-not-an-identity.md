# ADR 0122: A blocked tile is not an identity

Status: accepted (2026-08-18). Amends
[ADR 0120](0120-what-he-can-see-he-should-be-able-to-name.md), which weighed
decoding `gObjectEvents` and rejected it. New evidence from a later run on the
hosted-world path ([ADR 0103](0103-a-hosted-world-is-another-body.md)) shows
the two decisions answer different questions, and that 0120's own unfixed gap
is where the failure recurred.

## Context

ADR 0120 was accepted on the morning of 2026-08-18 and named its rejected
alternative precisely: decode `gObjectEvents`, put NPCs in the observation.
Two reasons were given.

1. **A permanent tax.** Every object class someone remembers to decode becomes
   addressable and everything else stays invisible, in two ROM adapters,
   forever.
2. **It does not help the case that started this.** The starter table is not an
   obstacle in the decoded map at all; he walked _onto_ the tile he thought it
   occupied.

Both were correct about the run 0120 was written from. Later the same day, run
`embodiment-5f4a6d59` failed differently, on the hosted world:

- T41 — "Oak is further west/north by the machines... **I don't have Oak's
  exact tile.** The red guy is Oak."
- T43 — "**North is blocked at (11,8) so Oak is probably on that tile.** Face
  north then A."
- T44 — "north is blocked so that's **almost certainly Oak**. Press A."
- T45 — read: _"It's like an encyclopedia, but the pages are blank."_
- T46 — "Oak's last line was about the Pokédex being blank. I need to get next
  to him — he should be on the left side of the room."

He had talked to a bookshelf. He then paced x=7↔11 along one row for the rest
of the run: 24 turns without a new tile, a 12-turn recurring loop, coherence
0.375. Professor Oak was not in the lab at all at that point in FireRed — the
script puts him on Route 1 — and nothing he could observe could tell him so.

This is not 0120's failure. He was not guessing coordinates; the minimap gave
him exact tiles and exact passability, and his notes quote them correctly
throughout. He was guessing **identity**. Labelled tile axes answer "which tile
is that?", which he already knew. They cannot answer "is the thing on it a
person, and is the person I want in this room at all?" — and an empty room is
the answer that would have ended this run in one turn.

Reason 2 therefore does not extend to this case. Reason 1 stands unchanged and
is now paid: the decoder exists twice, once per body.

0120's final consequence records that the hosted world body never received its
overlay, and that "the 66-turn failure this ADR is named for remains reachable
there." It was, six hours later.

## Decision

**The overworld observation carries the map's occupants, and a decoder that
cannot read them says so rather than reporting an empty room.**

- **`occupants` is a list of positions, not of characters.** Each entry is the
  object's `localId`, its `graphicsId`, its tile, and its facing. No name and no
  role: deciding a sprite is Professor Oak is interpretation, and interpretation
  belongs to whoever is playing. Where somebody is standing is the fact that was
  missing.
- **Absent and empty are different claims.** A decoder that does not read object
  events omits the field; an empty array asserts that nobody is standing here.
  A client that collapses the two tells a mind "nobody here" about a screen
  nobody read — a worse answer than silence, because it is actionable and wrong.
- **Empty is not "nothing to do here".** Only what the game models as a movable
  object appears: people and item balls. Tables, signs, and scenery are map
  terrain. ADR 0120's objection lands exactly here and is not answered — the
  starter table that ADR is named for is invisible to this field by
  construction, so the wording that reaches the mind says "nobody is standing
  in the room", never "the room is empty".
- **The base is derived from the two verified player offsets.** Both live inside
  entry 0 of the same array, so `FIRERED_OBJECT_EVENTS_OFFSET` is computed from
  them and a module-load check makes them agree. The **stride** is the one value
  empirical work did not establish; it comes from the decompilation and is
  unverified against the running ROM. Two filters carry that risk rather than a
  comment: an entry whose `active` bit is clear is dropped, and so is one whose
  map is not the map the save block names.
- **The map filter trusts the save block, not the array.** Entry 0 carries its
  own copy of the current map; only the save block's has been verified here, and
  a filter is worth exactly as much as the field it trusts.

**A direct interaction result stays attached to the object it came from.** When
a single A press is made while directly facing a listed occupant and the next
observation opens dialog, later turns see that object signature and exact
dialog together. This still does not name the occupant; it records “pressing A
toward this object opened text beginning `GARY: ...`.” The fact is bounded,
scoped to body generation, map, local event id, and sprite id, and absent when
that occupant is no longer present. It outranks self-authored notes because it
is a directly observed result rather than an interpretation.

**A dialog observation carries the text or refuses.** The hosted-world path
returned `lines: []` unconditionally — a stub, in place since the path was
built — so every dialog box on every world run reached the mind empty while the
world's own adapter had the decoded text in hand. Empty `lines` reads as "he
read it and it said nothing", after which he acts on a line he never saw. A
world that does not publish the text now yields no dialog observation at all
(`semantic_state_unavailable`), which the per-kind observe loop already treats
as context he does not get.

## Consequences

- **The frame is an unreliable narrator, which is the argument ADR 0120 did not
  weigh.** Its run was wrong about _where_ a seen object was; this one was wrong
  about _whether_ a person was there at all — "the red guy is Oak", three times,
  in three different places, about a professor the script had put on Route 1.
  Labelled axes make a confabulating reader precise rather than truthful.
  Decoded object events cannot hallucinate, and that is the whole of the case
  for paying the tax.
- ADR 0120's rejection of `gObjectEvents` is narrowed, not overturned. Labelled
  axes remain the answer to addressing things no decoder names — map
  decorations, the starter table, scenery. Occupants answer which blocked tiles
  are people. Neither subsumes the other, and the starter-table case still needs
  the axes.
- The tax 0120 named is real and now owed twice: `decodeFireRedObjectEvents`
  exists in `packages/firered` (world) and `integrations/gba-emulator` (local),
  with the same offsets and the same tests. A third body pays it a third time.
  This is the cost of the two-body split in ADR 0103, not a new debt.
- Object classes outside `gObjectEvents` stay invisible to `occupants`, exactly
  as 0120 predicted. That is what the frame's labelled axes are for.
- The stride is unverified against a running ROM. Until it is, a wrong stride
  degrades toward silence rather than invention — misaligned entries fail the
  `active` and map filters — but a live check against Oak's lab, where the
  aides' tiles are known, would retire the assumption. Worth doing before
  trusting occupants for anything beyond "is anybody here".
- The hosted world still has no labelled axes. 0120's named gap is unchanged by
  this record, and remains the reason its own failure mode is reachable on the
  path Clankie actually plays.
- Repeated dialog can correct a guessed name without turning `graphicsId` into
  an identity table. The stored fact says what interaction produced, not who a
  sprite must be.
