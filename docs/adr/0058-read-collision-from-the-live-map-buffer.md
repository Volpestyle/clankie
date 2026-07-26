# ADR 0058: Read collision from the live map buffer, and make a route an action

Status: accepted (James, 2026-07-25). The map-grid decoder, the enriched action
outcome, the adjacency observation, and the `walk_to` action are implemented and
covered by tests; the ROM-gated ones assert against collision that was first
established by hand.

## Context

An external harness played FireRed through the MCP surface
([ADR 0053](0053-mcp-possession-of-clankies-body.md)) and the cost of the first
six tiles was measured: **14 tool calls — 8 actions and 6 observations** — to
cross a bedroom and take one staircase. Two of those actions were presses into a
stair banister that returned looking exactly like successes.

Three properties of the surface caused that, and none of them were about the
model's judgement:

- **The action result did not say where the player ended up.** Every move cost a
  second call to find out.
- **Nothing distinguished a step from a bump.** `ramStateSha256` changes on a
  refused move too, because the bump animation is itself a state change, so it
  could not be used as a proxy.
- **Nothing described the map.** The decoder exposed player coordinates and
  facing only. `gba_emulator_observe` returns the rendered screen for exactly
  this reason — ADR 0049 already recorded that a caller reading only RAM
  "discovers furniture by walking into it" — but a PNG makes a caller do tile
  arithmetic on pixels to guess what is solid.

The existing real-scenario driver worked around the third point by remembering
"the set of directed transitions the emulator itself refused". That is honest
about observed reality, but it is memory of walls already walked into. It cannot
route around a wall that has not yet been hit.

## Decision

### Collision is read, not remembered

`gBackupMapLayout` — FireRed's live map buffer — is decoded from IWRAM
`0x03005040` as `{ s32 width; s32 height; u16 *map; }`, with each tile a `u16`
carrying metatile id in bits 0-9, collision in 10-11, and elevation in 12-15.
The player's coordinates were already in the buffer's border-inclusive space,
which is why they read as 13/13 in a room whose real origin is 0/0.

The address was derived the same way `firered-ram-map.ts` documents deriving the
others: boot the pinned savestate, scan RAM for a struct whose dimensions and
EWRAM-resident pointer are plausible, and keep only the candidate whose collision
bits reproduce tiles a walker had already proved open or blocked by bumping into
them. Exactly one candidate survived, and its grid tracked the 27x23 -> 28x24
change when the player took the stairs down.

Reading beats remembering because the walls are already in RAM. The refused-
transition memory stays useful for what collision genuinely does not cover.

**The border is load-bearing.** The buffer carries seven tiles of border filler
on every side, and that filler decodes to collision 0. Treating the buffer as
uniformly meaningful would report the void beyond a room's walls as open floor,
so every query is clamped to the real map and fails closed outside it.

**Collision is not reachability, and the code says so rather than implying
otherwise.** The bits model walls. They do not model ledges (one-way), water
(needs Surf), elevation transitions, or NPCs — object events occupy tiles without
appearing in collision at all. An open tile therefore means "not a wall", not
"reachable on foot".

### A route is a catalogued action

`walk_to` plans breadth-first over that grid and is a real entry in the action
catalogue, implemented in the adapter — **not** an MCP-only convenience. The MCP
README's rule that nothing there invents a capability is what forces this: a
pathing tool that existed only for the external harness would be a second
definition of what Clankie can do in a game, and his own free-play loop would not
have it. It maps to the existing `emulator.gba.input` capability, because walking
is a burst of presses the session was already allowed, and it draws from the same
input and frame budget such a burst draws from.

**The route is verified every step, because the plan can stop being true while
it is walked.** Collision has no NPCs in it, so a planned tile can be occupied.
Each step compares position before and after; if the player did not move, the
action stops and reports `blockedAt` rather than mashing a dead route. A warp
tile likewise ends the route, because the plan was made against a map that is no
longer loaded.

`walk_to` refuses an impassable or unreachable target instead of walking as close
as it can — answering a different question than the one asked would be worse than
refusing.

**`walk_to` moves within a map, not between maps.** Warp tiles carry blocking
collision and transport anyway: the stairs at `(16,9)` in `players-house-2f`
read as a wall, yet pressing left into them from `(17,9)` arrives on
`players-house-1f`. A route planned from collision alone can therefore never
step onto a door or a staircase. Crossing maps stays a directional press, and
`moved` reports it correctly because the map id changes. Routing through warps
would need the map header's warp-event list decoded as well, which is a separate
change; a test pins the current behaviour so that change is deliberate.

### An action result describes the state it produced

`button_press` and `walk_to` now return the resulting position, facing, `moved`,
`turned`, and the surrounding tiles. This is the change that removes the second
call per move, and `moved` is what makes a bump legible without one.

## Consequences

- A caller can see a wall before walking into it, and crossing a room is one
  action instead of a probe-and-observe loop.
- The deterministic double implements the same seam from the bounds it already
  enforced, so CI covers adjacency and pathing with no ROM.
- `GbaCoreState` gained optional `surroundings`/`mapSize`, derived in the double's
  accessor rather than stored — `ramStateSha256` hashes the held state, and every
  frozen scenario digest depends on its shape.
- The map grid is a seam query rather than a state field, because the state view
  is cloned on every read and a whole grid per observation would make looking
  expensive to pay for something only pathing uses.
- Collision decoding is pinned to FireRed US v1.0 like the rest of the profile.
  Another ROM fails closed rather than reporting a confidently wrong grid.
