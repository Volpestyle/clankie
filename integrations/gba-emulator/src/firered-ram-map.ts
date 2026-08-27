/**
 * FireRed EWRAM map — exactly the fields the real core decodes, no more.
 *
 * Every offset below was verified empirically against the running pinned ROM
 * (Pokémon FireRed (U), SHA-256 3d0c79f1…, see the frozen fixture) by input
 * differencing from the pinned bedroom savestate: press a d-pad direction,
 * step frames, and diff the 256 KB EWRAM snapshot for the value that tracks
 * the input. The offsets match the community pokefirered decompilation's
 * `gObjectEvents` layout (base 0x02036E38, 0x24-byte entries; entry 0 is the
 * player), which corroborates but does not replace the empirical check.
 *
 * mGBA publishes both EWRAM and IWRAM through libretro's memory-map callback
 * (ADR 0040). The fields below live at fixed EWRAM addresses and need no
 * pointer chase; version-pinned IWRAM/save-block decoding is layered on this
 * same memory surface.
 */

import type { GbaCoreSurroundings, GbaCoreTileView } from "./core-double.ts";

/** EWRAM offset of the player object's current tile coords (two s16 LE: x, y). */
const FIRERED_PLAYER_COORDS_OFFSET = 0x36e48;
/** EWRAM offset of the player object's facing-direction byte. */
const FIRERED_PLAYER_FACING_OFFSET = 0x36e58;
/** GBA EWRAM bus base address, for documentation of absolute addresses. */
export const GBA_EWRAM_BASE = 0x02000000;
export const GBA_EWRAM_SIZE = 0x40000;
const GBA_IWRAM_SIZE = 0x8000;

/**
 * IWRAM offset of `gBackupMapLayout` — `{ s32 width; s32 height; u16 *map; }`.
 *
 * Derived by the same input-differencing method as the offsets above, then
 * confirmed against independently observed collision: boot the pinned bedroom
 * savestate, scan RAM for a struct whose dimensions and EWRAM-resident pointer
 * are plausible, and keep only the candidate whose decoded collision bits
 * reproduce tiles a walker had already proved blocked or open by bumping into
 * them. Exactly one candidate survived, at absolute 0x03005040, and its grid
 * tracked the 27x23 -> 28x24 change when the player took the stairs from
 * `players-house-2f` to `players-house-1f`.
 *
 * The layout is the *live* map buffer, so collision is read rather than
 * remembered. A driver that instead accumulates "transitions the emulator
 * refused" only ever learns the walls it has already walked into.
 */
const FIRERED_BACKUP_MAP_LAYOUT_OFFSET = 0x5040;

/**
 * Tiles of border the backup buffer carries on each side (GBA `MAP_OFFSET`).
 * Player coords are in this same border-inclusive space, which is why they read
 * as 13/13 in a room whose real origin is 0/0.
 */
export const FIRERED_MAP_BORDER_OFFSET = 7;
/** Backup width/height exceed the real map by these amounts (`MAP_OFFSET_W/H`). */
const BACKUP_WIDTH_MARGIN = 15;
const BACKUP_HEIGHT_MARGIN = 14;
/** Generous bound; real FireRed maps are far smaller. Beyond it we fail closed. */
const MAX_MAP_DIMENSION = 200;

/** A tile is `u16`: id in bits 0-9, collision in 10-11, elevation in 12-15. */
const METATILE_ID_MASK = 0x03ff;

export interface FireRedMapGrid {
  /** Backup-buffer dimensions, border included. */
  width: number;
  height: number;
  /** Real map dimensions, border excluded. */
  mapWidth: number;
  mapHeight: number;
  /** Row-major backup buffer, border included, indexed by player coords. */
  tiles: Uint16Array;
}

/**
 * Decode the live map grid. Fails closed on any implausible dimension or
 * pointer rather than handing back a grid that would be confidently wrong.
 */
export function decodeFireRedMapGrid(iwram: Uint8Array, ewram: Uint8Array): FireRedMapGrid {
  if (iwram.length !== GBA_IWRAM_SIZE) {
    throw new Error(`Expected a ${String(GBA_IWRAM_SIZE)}-byte IWRAM snapshot`);
  }
  if (ewram.length !== GBA_EWRAM_SIZE) {
    throw new Error(`Expected a ${String(GBA_EWRAM_SIZE)}-byte EWRAM snapshot`);
  }
  const width = readS32(iwram, FIRERED_BACKUP_MAP_LAYOUT_OFFSET);
  const height = readS32(iwram, FIRERED_BACKUP_MAP_LAYOUT_OFFSET + 4);
  const pointer = readU32(iwram, FIRERED_BACKUP_MAP_LAYOUT_OFFSET + 8);

  if (width <= BACKUP_WIDTH_MARGIN || height <= BACKUP_HEIGHT_MARGIN) {
    throw new Error(`Decoded map layout ${String(width)}x${String(height)} is smaller than its own border`);
  }
  if (width > MAX_MAP_DIMENSION || height > MAX_MAP_DIMENSION) {
    throw new Error(`Decoded map layout ${String(width)}x${String(height)} is outside the plausible range`);
  }
  // The buffer lives in EWRAM; a pointer anywhere else means we are not looking
  // at a loaded map (mid-transition, or a wrong-version layout).
  const start = pointer - GBA_EWRAM_BASE;
  const byteLength = width * height * 2;
  if (start < 0 || start + byteLength > GBA_EWRAM_SIZE) {
    throw new Error(`Decoded map buffer pointer 0x${pointer.toString(16)} does not address EWRAM`);
  }

  const tiles = new Uint16Array(width * height);
  for (let i = 0; i < tiles.length; i += 1) {
    tiles[i] = (ewram[start + i * 2] ?? 0) | ((ewram[start + i * 2 + 1] ?? 0) << 8);
  }
  return {
    width,
    height,
    mapWidth: width - BACKUP_WIDTH_MARGIN,
    mapHeight: height - BACKUP_HEIGHT_MARGIN,
    tiles,
  };
}

/**
 * Whether a tile is inside the real map rather than border filler.
 *
 * This check is load-bearing: border tiles decode to collision 0, so treating
 * the buffer as uniformly meaningful would report the void beyond a room's
 * walls as walkable floor.
 */
function isInsideFireRedMap(grid: FireRedMapGrid, x: number, y: number): boolean {
  const min = FIRERED_MAP_BORDER_OFFSET;
  return x >= min && y >= min && x < min + grid.mapWidth && y < min + grid.mapHeight;
}

function tileAt(grid: FireRedMapGrid, x: number, y: number): number {
  if (!isInsideFireRedMap(grid, x, y)) {
    throw new Error(`Tile (${String(x)}, ${String(y)}) is outside the loaded map`);
  }
  return grid.tiles[y * grid.width + x] ?? 0;
}

/** Elevation bits, which is what makes bridges and stair landings work. */
function fireRedElevationAt(grid: FireRedMapGrid, x: number, y: number): number {
  return (tileAt(grid, x, y) >> 12) & 0xf;
}

function fireRedMetatileAt(grid: FireRedMapGrid, x: number, y: number): number {
  return tileAt(grid, x, y) & METATILE_ID_MASK;
}

/**
 * Whether the collision bits leave this tile open, false outside the map.
 *
 * This is the collision bit and nothing more. It does not model ledges (which
 * are one-way), water (which needs Surf), or elevation transitions, so an open
 * tile is "not a wall" rather than "reachable on foot". Callers that need those
 * distinctions should read elevation and the metatile id too.
 */
export function isFireRedTilePassable(grid: FireRedMapGrid, x: number, y: number): boolean {
  if (!isInsideFireRedMap(grid, x, y)) return false;
  return (((grid.tiles[y * grid.width + x] ?? 0) >> 10) & 0x3) === 0;
}

/** Unit step for each facing, in border-inclusive map coords. */
const FIRERED_DIRECTION_STEPS = {
  north: { dx: 0, dy: -1 },
  south: { dx: 0, dy: 1 },
  west: { dx: -1, dy: 0 },
  east: { dx: 1, dy: 0 },
} as const;

export type FireRedDirection = keyof typeof FIRERED_DIRECTION_STEPS;

function fireRedTileView(grid: FireRedMapGrid, x: number, y: number): GbaCoreTileView {
  if (!isInsideFireRedMap(grid, x, y)) {
    return { x, y, passable: false, elevation: null, metatileId: null };
  }
  return {
    x,
    y,
    passable: isFireRedTilePassable(grid, x, y),
    elevation: fireRedElevationAt(grid, x, y),
    metatileId: fireRedMetatileAt(grid, x, y),
  };
}

/**
 * The four neighbours plus whatever the player faces.
 *
 * This is the view a person has by looking at the screen and that a caller
 * reading only coordinates does not: without it, the only way to discover a
 * wall is to walk into it.
 */
export function fireRedSurroundings(
  grid: FireRedMapGrid,
  x: number,
  y: number,
  facing: FireRedDirection,
): GbaCoreSurroundings {
  const at = (direction: FireRedDirection): GbaCoreTileView => {
    const step = FIRERED_DIRECTION_STEPS[direction];
    return fireRedTileView(grid, x + step.dx, y + step.dy);
  };
  return { north: at("north"), east: at("east"), south: at("south"), west: at("west"), ahead: at(facing) };
}

/**
 * EWRAM offset of `gMapHeader` — the loaded map's header, whose `events` and
 * `connections` pointers name every way off this map.
 *
 * Derived by the same method as the offsets above: propose the community
 * pokefirered decompilation's address (0x02036DFC), then scan every 4-byte-
 * aligned EWRAM offset for a competing struct whose layout pointer names a ROM
 * `MapLayout` matching the live `gBackupMapLayout` dimensions, whose event and
 * script pointers address the ROM, and whose decoded warp coordinates all land
 * inside the map. Exactly one candidate survived across three savestates on
 * three different maps (players-house-2f, players-house-1f, pallet-town), and
 * its decoded warps reproduced independently known ground truth: the 2f stairs
 * event at map-local (10,2) targeting players-house-1f, the 1f door mats at
 * (4,8)/(5,8) targeting pallet-town, and pallet-town's doors targeting the two
 * houses and Oak's lab.
 */
export const FIRERED_MAP_HEADER_OFFSET = 0x36dfc;
/** GBA cartridge ROM bus base address; map event data lives in ROM. */
export const GBA_ROM_BASE = 0x08000000;

/**
 * Connection direction byte values, verified against live play: pallet-town's
 * direction-2 connection is Route 1 (3:19), which the player enters by walking
 * north off the map, and its direction-1 connection is the water route to the
 * south. They match the GBA CONNECTION_SOUTH/NORTH/WEST/EAST constants.
 */
const CONNECTION_DIRECTION_BY_VALUE: Record<number, "south" | "north" | "west" | "east"> = {
  1: "south",
  2: "north",
  3: "west",
  4: "east",
};

/** One way off this map through a warp event: a door, stairway, or mat. */
interface FireRedWarpEvent {
  /** Warp tile coords in the border-inclusive space player coords use. */
  x: number;
  y: number;
  destinationMapGroup: number;
  destinationMapNum: number;
}

/** One way off this map by walking over an edge into the adjacent map. */
interface FireRedMapConnection {
  direction: "north" | "south" | "west" | "east";
  destinationMapGroup: number;
  destinationMapNum: number;
}

export interface FireRedMapExits {
  warps: FireRedWarpEvent[];
  connections: FireRedMapConnection[];
}

/** Bounds far above any real FireRed map's event tables; beyond them we fail closed. */
const MAX_WARP_EVENTS = 32;
const MAX_MAP_CONNECTIONS = 8;

/**
 * Decode every exit from the loaded map: warp events (doors, stairs, mats) and
 * edge connections. Returns null rather than guessing when the header is not
 * in a decodable state — mid-warp, or a wrong-version layout — mirroring how a
 * missing map grid reports absence.
 */
export function decodeFireRedMapExits(
  ewram: Uint8Array,
  romBytes: Uint8Array,
  grid: FireRedMapGrid,
): FireRedMapExits | null {
  if (ewram.length !== GBA_EWRAM_SIZE) {
    throw new Error(`Expected a ${String(GBA_EWRAM_SIZE)}-byte EWRAM snapshot`);
  }
  const romU8 = (address: number): number | null => {
    const offset = address - GBA_ROM_BASE;
    if (offset < 0 || offset >= romBytes.length) return null;
    return romBytes[offset] ?? null;
  };
  const romU32 = (address: number): number | null => {
    const b0 = romU8(address);
    const b1 = romU8(address + 1);
    const b2 = romU8(address + 2);
    const b3 = romU8(address + 3);
    if (b0 === null || b1 === null || b2 === null || b3 === null) return null;
    return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
  };
  const romS16 = (address: number): number | null => {
    const b0 = romU8(address);
    const b1 = romU8(address + 1);
    if (b0 === null || b1 === null) return null;
    return ((b0 | (b1 << 8)) << 16) >> 16;
  };
  const isRomPointer = (value: number): boolean =>
    value >= GBA_ROM_BASE && value < GBA_ROM_BASE + romBytes.length;

  // struct MapHeader { MapLayout *mapLayout; MapEvents *events; u8 *mapScripts;
  //                    MapConnections *connections; ... }
  const eventsPointer = readU32(ewram, FIRERED_MAP_HEADER_OFFSET + 4);
  const connectionsPointer = readU32(ewram, FIRERED_MAP_HEADER_OFFSET + 12);
  if (!isRomPointer(eventsPointer)) return null;
  if (connectionsPointer !== 0 && !isRomPointer(connectionsPointer)) return null;

  // struct MapEvents { u8 objectEventCount, warpCount, coordEventCount,
  //                    bgEventCount; ...; WarpEvent *warps; ... }
  const warpCount = romU8(eventsPointer + 1);
  const warpsPointer = romU32(eventsPointer + 8);
  if (warpCount === null || warpCount > MAX_WARP_EVENTS) return null;
  if (warpCount > 0 && (warpsPointer === null || !isRomPointer(warpsPointer))) return null;
  const warps: FireRedWarpEvent[] = [];
  for (let index = 0; index < warpCount; index += 1) {
    // struct WarpEvent { s16 x, y; u8 elevation, warpId, mapNum, mapGroup; }
    const base = (warpsPointer ?? 0) + index * 8;
    const x = romS16(base);
    const y = romS16(base + 2);
    const mapNum = romU8(base + 6);
    const mapGroup = romU8(base + 7);
    if (x === null || y === null || mapNum === null || mapGroup === null) return null;
    // Event coords are map-local; a coordinate outside the live map means the
    // header and the loaded layout disagree, so nothing here is trustworthy.
    if (x < 0 || x >= grid.mapWidth || y < 0 || y >= grid.mapHeight) return null;
    warps.push({
      x: x + FIRERED_MAP_BORDER_OFFSET,
      y: y + FIRERED_MAP_BORDER_OFFSET,
      destinationMapGroup: mapGroup,
      destinationMapNum: mapNum,
    });
  }

  const connections: FireRedMapConnection[] = [];
  if (connectionsPointer !== 0) {
    // struct MapConnections { s32 count; MapConnection *connections; }
    const count = romU32(connectionsPointer);
    const listPointer = romU32(connectionsPointer + 4);
    if (count === null || count > MAX_MAP_CONNECTIONS) return null;
    if (count > 0 && (listPointer === null || !isRomPointer(listPointer))) return null;
    for (let index = 0; index < count; index += 1) {
      // struct MapConnection { u8 direction; s32 offset; u8 mapGroup, mapNum; }
      const base = (listPointer ?? 0) + index * 12;
      const directionValue = romU8(base);
      const mapGroup = romU8(base + 8);
      const mapNum = romU8(base + 9);
      if (directionValue === null || mapGroup === null || mapNum === null) return null;
      const direction = CONNECTION_DIRECTION_BY_VALUE[directionValue];
      // Dive/emerge connections (5/6) exist in the format; only edges are exits.
      if (direction === undefined) continue;
      connections.push({ direction, destinationMapGroup: mapGroup, destinationMapNum: mapNum });
    }
  }

  return { warps, connections };
}

/**
 * Facing byte values observed by turning the player in place (3-frame taps):
 * 1=south, 2=north, 3=west, 4=east (GBA DIR_SOUTH/NORTH/WEST/EAST).
 */
const FACING_BY_VALUE: Record<number, "south" | "north" | "west" | "east"> = {
  1: "south",
  2: "north",
  3: "west",
  4: "east",
};

export interface FireRedOverworldFields {
  /** Player tile x (map coords including the GBA map border offset of 7). */
  x: number;
  /** Player tile y (map coords including the GBA map border offset of 7). */
  y: number;
  facing: "north" | "east" | "south" | "west";
}

const readS16 = (ewram: Uint8Array, offset: number): number => {
  const low = ewram[offset];
  const high = ewram[offset + 1];
  if (low === undefined || high === undefined) throw new Error("EWRAM read out of range");
  return ((low | (high << 8)) << 16) >> 16;
};

const readU32 = (bytes: Uint8Array, offset: number): number => {
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) {
    throw new Error("RAM read out of range");
  }
  return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
};

const readS32 = (bytes: Uint8Array, offset: number): number => readU32(bytes, offset) | 0;

/**
 * Decode the verified overworld fields from an EWRAM snapshot. Fails closed:
 * any value outside the empirically verified shape throws instead of
 * guessing, so the adapter surfaces uncertainty rather than fabricating state.
 */
export function decodeFireRedOverworld(ewram: Uint8Array): FireRedOverworldFields {
  if (ewram.length !== GBA_EWRAM_SIZE) {
    throw new Error(`Expected a ${String(GBA_EWRAM_SIZE)}-byte EWRAM snapshot`);
  }
  const x = readS16(ewram, FIRERED_PLAYER_COORDS_OFFSET);
  const y = readS16(ewram, FIRERED_PLAYER_COORDS_OFFSET + 2);
  const facingValue = ewram[FIRERED_PLAYER_FACING_OFFSET];
  const facing = facingValue === undefined ? undefined : FACING_BY_VALUE[facingValue];
  if (x < 0 || y < 0 || x > 4_096 || y > 4_096) {
    throw new Error(`Decoded player coords (${String(x)}, ${String(y)}) are outside the plausible range`);
  }
  if (facing === undefined) {
    throw new Error(`Decoded facing byte ${String(facingValue)} is not a known direction`);
  }
  return { x, y, facing };
}

/**
 * `gObjectEvents`: the player and every NPC loaded on the current map.
 *
 * The base is derived, not asserted. Both verified player offsets are fields
 * of entry 0 — 0x36e48 is its `currentCoords` and 0x36e58 its facing byte — so
 * two independently verified offsets have to agree on where the array starts.
 *
 * The **stride** is the one thing here empirical work did not establish. It is
 * the pokefirered decompilation's `struct ObjectEvent`, corroborated by the
 * size the symbol table gives `gObjectEvents` (0x240 = 16 entries of 0x24),
 * and unverified against the running ROM. What stands between a wrong stride
 * and a fabricated NPC is the pair of filters in the decode — an inactive
 * `active` bit and a map that is not the player's both drop the entry.
 */
const OBJECT_EVENT_CURRENT_COORDS = 0x10;
const OBJECT_EVENT_FACING = 0x20;
const FIRERED_OBJECT_EVENTS_OFFSET = FIRERED_PLAYER_COORDS_OFFSET - OBJECT_EVENT_CURRENT_COORDS;
const FIRERED_OBJECT_EVENT_STRIDE = 0x24;
const FIRERED_OBJECT_EVENT_COUNT = 16;

if (FIRERED_PLAYER_FACING_OFFSET - OBJECT_EVENT_FACING !== FIRERED_OBJECT_EVENTS_OFFSET) {
  throw new Error("FireRed player coords and facing disagree about the gObjectEvents base");
}

const OBJECT_EVENT_FLAGS = 0x00;
const OBJECT_EVENT_GRAPHICS_ID = 0x05;
const OBJECT_EVENT_LOCAL_ID = 0x08;
const OBJECT_EVENT_MAP_NUM = 0x09;
const OBJECT_EVENT_MAP_GROUP = 0x0a;

export interface FireRedObjectEvent {
  /** The map-local event id scripts address this object by. */
  localId: number;
  /** Which sprite it wears. Identity is a script's business, not the decoder's. */
  graphicsId: number;
  /** Tile coords in the same space as the player's, border offset included. */
  x: number;
  y: number;
  /** Null when this object has not faced anywhere yet — a real state, not a failure. */
  facing: "north" | "east" | "south" | "west" | null;
}

/**
 * Every active object event standing on the player's own map, the player
 * excluded. Null when there is no initialised player object — a title screen,
 * an intro, a map still loading.
 *
 * `onMap` is the caller's decoded save-block map, not entry 0's own copy of
 * it. Both exist in RAM; only the save block's has been verified here, and a
 * filter is worth exactly as much as the field it trusts.
 *
 * Individual entries are skipped rather than thrown on: one unreadable slot
 * costs one NPC, while a throw would cost the whole observation the mind was
 * about to act on.
 */
export function decodeFireRedObjectEvents(
  ewram: Uint8Array,
  onMap: { readonly mapGroup: number; readonly mapNum: number },
): FireRedObjectEvent[] | null {
  if (ewram.length !== GBA_EWRAM_SIZE) {
    throw new Error(`Expected a ${String(GBA_EWRAM_SIZE)}-byte EWRAM snapshot`);
  }
  try {
    decodeFireRedOverworld(ewram);
  } catch {
    return null;
  }
  const entry = (index: number, field: number): number =>
    FIRERED_OBJECT_EVENTS_OFFSET + index * FIRERED_OBJECT_EVENT_STRIDE + field;
  const { mapGroup, mapNum } = onMap;

  const objects: FireRedObjectEvent[] = [];
  for (let index = 1; index < FIRERED_OBJECT_EVENT_COUNT; index += 1) {
    const flags = ewram[entry(index, OBJECT_EVENT_FLAGS)];
    // Bit 0 is `active`. An inactive slot keeps whatever the last object to
    // occupy it left behind, so reading one reports a ghost.
    if (flags === undefined || (flags & 1) === 0) continue;
    // Objects from an adjacent connected map stay loaded. They are real, but
    // they are not in the room, and offering them as such is how a mind ends
    // up walking at a wall.
    if (ewram[entry(index, OBJECT_EVENT_MAP_NUM)] !== mapNum) continue;
    if (ewram[entry(index, OBJECT_EVENT_MAP_GROUP)] !== mapGroup) continue;
    const localId = ewram[entry(index, OBJECT_EVENT_LOCAL_ID)];
    const graphicsId = ewram[entry(index, OBJECT_EVENT_GRAPHICS_ID)];
    if (localId === undefined || graphicsId === undefined) continue;
    const x = readS16(ewram, entry(index, OBJECT_EVENT_CURRENT_COORDS));
    const y = readS16(ewram, entry(index, OBJECT_EVENT_CURRENT_COORDS + 2));
    if (x < 0 || y < 0 || x > 4_096 || y > 4_096) continue;
    objects.push({
      localId,
      graphicsId,
      x,
      y,
      facing: FACING_BY_VALUE[ewram[entry(index, OBJECT_EVENT_FACING)] ?? 0] ?? null,
    });
  }
  return objects;
}
