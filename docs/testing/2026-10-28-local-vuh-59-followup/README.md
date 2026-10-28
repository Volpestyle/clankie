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

Part 2, one persona per hire, follows in its own change.
