# LOCAL-VUH-59 follow-up: tracker names for existing seats

Tracks: LOCAL-VUH-59 in the Clankie Work built-in tracker. The lead's live
readback on 65350e7cf (comment bf8b73be) found two gaps.

## Part 1: the save response and PC seats

- `linear_save_comment` answered with `author: "Local owner"` even when the
  stored comment named its writer. The built-in tracker builds a write's
  response before it stamps the writer, then added only `createdByActor` and
  `updatedByActor` to it. Now it also recomputes `author`, `user` and
  `createdBy` from that writer.
- A remote hire records its seat already qualified (`pc/term_…`), and the name
  lookup qualified it again (`pc/pc/term_…`), so a PC worker's persona could
  never match. It now qualifies only an unqualified seat. The test fixture
  records remote seats the way production does.

`tracker-role-budget.integration.test.ts` now checks each write's own reply.
Reverting the tracker fix makes Lark's reply read `"Local owner"`
(`red-save-response.txt`). Reverting the seat fix leaves the PC worker unnamed
(`red-pc-seat.txt`). With both fixes, 6 of 6 pass.

## Part 2: one persona per hire

**Cause, from the live store (read-only).** Herdr keeps no `agent_name` for a
hired Claude pane: its saved session has only the label. A Codex hire keeps
its own, `ione-d524`. About 30 seconds after a Claude hire, the census saw
an unnamed pane and minted a second persona for the same occupant, keyed by the
pane, and the roster switched to it. 183 of 1,320 occupants had two bindings,
including each of the twelve most recent hires, and `personaForOccupant` needs
exactly one. Wynn's pane persona was named after the terminal title; Sable's
was picked as "Quill". The hire's own persona was named after its handle
(`wynn-e3f1`), because the census had filed Clankie's handle as an owner's name.

**Fix** (`personas.ts`, ADR 0147 amendment). The census works from two
recorded facts, never from a name's shape:

- A binding records `hired` when Clankie minted its subject. That happens at
  adoption, or on a census where Clankie's hire ledger (ProjectHires) holds the
  title that occupant, or that still-starting pane, was hired under and the
  subject is the key `herdrAgentName(title, tag)` makes.
- `ownerNamed` records each persona the owner named, through `update_persona`
  or a Herdr rename. Every Herdr name that Clankie did not mint is the owner's.
- Both markers live in `personas.markers.json`, so `personas.json` keeps the
  shape the previous runtime reads strictly. A missing markers file reads as
  empty.
- A persona the census files under Clankie's handle reads like a hire's name,
  and the hire's title replaces it at adoption.
- An unnamed pane whose exact occupant holds exactly one `hired` binding keeps
  that persona. The stale pane binding is dropped unless the owner named it.
- The captain's exact seat-and-occupant persona lookup moved onto
  `PersonaStore.boundPersona`. Now `tracker-role-budget` drives the real store
  and hire ledger through each hire's life instead of a name fixture.

**Review round 1.** Corvin found that the first candidate (3e4c9c086) told
Clankie's handles from owner names by shape (`name-1a2b`). An owner's
`vuh-2933` was read as a handle and shown as "Vuh". It also inferred owner
names by exclusion. Both now come from records, as the lead decided.

**Review round 2.** Round 1 wrote the markers into `personas.json`. The
previous runtime's strict schema then refused the whole file, so an owner's
rollback would have broken every census. The markers moved to their own file,
as the lead decided. The census key now comes from `subjectForHerdrName`
itself.

**Review round 3.** A body transfer (ADR 0286) moved `personas.json` but not
the new markers file, so owner names lost their protection on every move, and
a destination kept its own old markers. The markers file is now one of the
transfer's state entries.

**Proof.**

- `personas.test.ts` loads the live shape with its real persona ids: Sable
  with "Quill", Wynn with his title persona, a hire whose pane persona the owner
  named "Juniper", and a hand-started pane.
  - Without the ledger nothing moves.
  - With it, Sable and Wynn come back as themselves, each bound once, and
    the markers file records their subjects as `hired`.
  - The owner's "Juniper" and the hand-started pane are unchanged.
  - Juniper keeps its binding when the hire's handle is observed again.
  - A restart's census keeps all of it from the markers alone.
- An owner's `vuh-2933` and a later `fix-2026` keep their names across a
  restart, beside a hire named Lark. A hire is named by its title whichever
  census sees it first. An app name spelled like the handle stays. A PC hire
  whose 32-character key lost part of its tag is still the hire's.
- A file this store writes parses under the previous runtime's strict
  schema, and reads back with its markers. Without the markers file it reads
  as unmarked, and the ledger marks the hire again.
- Rollback probe (`rollback-review-r2.txt`): one state directory, read in
  turn by this store, the previous runtime's `personas.ts` (17ff7d461) and
  this store again, reconciles to Wynn and Juniper each time. The round-1
  candidate's file made the previous runtime throw "Agent identity state is
  unreadable".
- `body-transfer-hosted.integration.test.ts` moves a Mac whose owner named a
  hire's pane persona "Juniper" into a managed body that already had its own
  markers. The Mac's markers replace them, and the body's first census still
  shows Juniper. Without the entry the body's old markers stay, and the test
  fails.
- In `tracker-role-budget`, Lark (Mac) and Wren (PC) start under handles, are
  adopted, and then lose their Herdr names. Their comments are named Lark and
  Wren.
- Red runs:
  - With the base persona store, the roster reads Quill and "Clankie captain
    brief assignment", and Lark's comment reads `seat-w1:p1`
    (`red-one-persona.txt`).
  - With the first candidate's store, the owner's `vuh-2933` reads "Vuh", and
    the owner's `wren-3c4d` reads "Wren" (`red-owner-handle.txt`).
- Each of nineteen mutations fails a shipped test (`mutations-review.txt`).
  They include every survivor the reviews found, moving the markers back into
  `personas.json`, and leaving them out of the body transfer.
- In `apps/clankie/test`, 191 of 191 pass across these ten files:
  - `personas.test.ts`
  - `tracker-role-budget.integration.test.ts`
  - `fleet-resource-hire.integration.test.ts`
  - `persona-project-migration.test.ts`
  - `persona-projection.integration.test.ts`
  - `codex-hired-seat-protocol.integration.test.ts`
  - `fleet-project-membership.test.ts`
  - `project-hires.test.ts`
  - `project-hire-pane.integration.test.ts`
  - `body-transfer-hosted.integration.test.ts`
- Against a read-only copy of the live store:
  - 128 of the 168 occupants with a pane binding and a named binding rejoin
    one hire binding.
  - 37 have no ledger allocation. The ledger began on 2026-10-03, and most of
    them are older.
  - Among the 688 hire-shaped bindings, every one with an allocation matches
    its hire's title.

**Limit.**

- No durable trail shows which existing names the owner gave in the app.
  `update_persona` was not logged, and the conversation title it rewrites is
  also written by the census. So an unmarked pane persona on a hired occupant
  counts as the census's, and its seat shows the hire's name. The record is
  kept offline.
- A hire whose pane persona the owner names from now on keeps two bindings, so
  the tracker names that seat by its id. Its roster name is the owner's.
- An occupant with no ledger allocation keeps both bindings.
