# ADR 0089: The map is his to read

Status: accepted (James, 2026-08-11). Extends
[ADR 0058](0058-read-collision-from-the-live-map-buffer.md), which read
collision from the live map buffer but handed it only to the pathfinder, and
lifts part of that ADR's warp deferral: the map header's warp-event list and
connection list are now decoded. Routing _through_ warps mid-route stays
refused; entering a targeted one is now a planned walk.

## Context

A live free-play session on 2026-08-10 measured what ADR 0058 left in place.
Of thirty turns, seven were `walk_to` rejections, every one `no_path_to_target`,
and each cost a model turn (~9s) that produced nothing. The journal shows why:
the player chose target tiles by reading the screenshot — "about twelve tiles
west and one south — my last coordinate guess" — because nothing in his view
showed which tiles are walkable. The adapter held the full collision grid the
whole time; `planWalk` consulted it every turn; the player never saw it.

Three properties of the surface caused the waste:

- **The grid was the pathfinder's, not the player's.** His spatial senses were
  position, facing, a five-tile adjacency cross, and the screenshot. Estimating
  tile coordinates from pixels is exactly the arithmetic ADR 0058 said a PNG
  forces.
- **A refusal said no and nothing else.** `no_path_to_target` did not
  distinguish an off-map tile from a wall from an unreachable island, and named
  no alternative — so every refusal was answered with another guess.
- **Exits did not exist.** "Leave town northward" has no addressable target
  when neither warp events nor edge connections are decoded, so the player
  probed the treeline: `(12,1)`, `(18,1)`, `(21,1)`, all refused. The failed
  turn-0 target `(10,16)` turned out to be an actual warp event tile.

## Decision

### The player sees the grid the pathfinder walks

The overworld observation carries a `minimap`: a crop of the collision grid
around the player, one character per tile — `@` player, `.` open, `#` blocked,
`D` a warp tile — with `topLeft` naming the crop's map coordinate so any cell
converts to a `walk_to` target by addition. It is derived at observation time
from the same `mapGrid()` seam query `walk_to` plans over, so the map he reads
and the map he walks cannot disagree. Information, never advice: no route,
no highlight, no suggestion rides along.

### A refusal names what would have to be different

`walk_to` refusals now classify: `walk_target_outside_map` states the bounds
the loaded map actually spans; `walk_target_impassable` and `no_path_to_target`
name the nearest reachable open tile to the request, found by the same bounded
breadth-first search that plans routes. The free-play effect line carries that
detail to the model. The refusal still refuses — `planWalk` never walks "as
close as it can", because answering a different question than the one asked
would be worse — but the answerable question is now stated.

### Exits are decoded, and a targeted door is an entrance

`gMapHeader` (EWRAM `0x02036DFC`) is decoded for the loaded map's warp events
and edge connections, derived and verified the same way ADR 0058 derived the
map buffer: propose the pokefirered decompilation's address, scan all of EWRAM
for competing candidates whose layout pointer matches the live grid and whose
decoded warps all land inside the map, and require exactly one survivor across
savestates on three different maps. The decoded warps reproduced independently
known ground truth (the 2f stairs event beside the banister; the 1f door mats;
pallet-town's three doors), and the connection directions were confirmed
against live play (pallet-town's direction-2 edge is Route 1, entered by
walking north). The overworld observation lists every exit with its
destination; warp tiles render as `D` on the minimap.

`walk_to` aimed at a warp event on blocking collision — an outdoor door — now
routes to a passable tile beside it and presses toward it, the same move a
person makes: FireRed's own stairs are used by standing beside them and
pressing in. The warp event is what makes the tile an entrance; plain walls
keep refusing exactly as before. A door that does not open (a locked entrance)
reports as the blocked tile it behaved as. Mid-route warps still end a route:
the plan was made against a map that is no longer loaded.

## Consequences

- Choosing a walk target is reading a map rather than estimating pixels, and a
  wrong choice teaches: the refusal names the bounds or the nearest real tile.
- "Enter the lab" is one action. The founding measurement of ADR 0058 — 14
  calls to cross a bedroom and take one staircase — falls again for doorways.
- The double renders a minimap from the bounds it already enforces, so CI
  covers the observation shape and the doorway walk (via a scripted two-map
  seam) with no ROM; the exits decode itself is ROM-gated like the grid.
- The exits decode is pinned to FireRed US v1.0 like the rest of the profile
  and fails closed to absence — a header mid-transition, an implausible count,
  a warp outside the loaded map all report null rather than a wrong exit.
- Two frozen behaviours changed deliberately, with their pinned tests updated
  in this change: `walk_to`'s wall/off-map refusals split into three named
  codes with detail, and a targeted blocked warp is walked beside and entered
  rather than refused.
