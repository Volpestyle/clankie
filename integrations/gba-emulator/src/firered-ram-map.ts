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

/** EWRAM offset of the player object's current tile coords (two s16 LE: x, y). */
export const FIRERED_PLAYER_COORDS_OFFSET = 0x36e48;
/** EWRAM offset of the player object's facing-direction byte. */
export const FIRERED_PLAYER_FACING_OFFSET = 0x36e58;
/** GBA EWRAM bus base address, for documentation of absolute addresses. */
export const GBA_EWRAM_BASE = 0x02000000;
export const GBA_EWRAM_SIZE = 0x40000;
/** GBA IWRAM bus base address. `gBackupMapLayout` is an IWRAM global. */
export const GBA_IWRAM_BASE = 0x03000000;
export const GBA_IWRAM_SIZE = 0x8000;

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
export const FIRERED_BACKUP_MAP_LAYOUT_OFFSET = 0x5040;

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
export function isInsideFireRedMap(grid: FireRedMapGrid, x: number, y: number): boolean {
  const min = FIRERED_MAP_BORDER_OFFSET;
  return x >= min && y >= min && x < min + grid.mapWidth && y < min + grid.mapHeight;
}

function tileAt(grid: FireRedMapGrid, x: number, y: number): number {
  if (!isInsideFireRedMap(grid, x, y)) {
    throw new Error(`Tile (${String(x)}, ${String(y)}) is outside the loaded map`);
  }
  return grid.tiles[y * grid.width + x] ?? 0;
}

/** Collision bits: 0 means the tile does not block movement. */
export function fireRedCollisionAt(grid: FireRedMapGrid, x: number, y: number): number {
  return (tileAt(grid, x, y) >> 10) & 0x3;
}

/** Elevation bits, which is what makes bridges and stair landings work. */
export function fireRedElevationAt(grid: FireRedMapGrid, x: number, y: number): number {
  return (tileAt(grid, x, y) >> 12) & 0xf;
}

export function fireRedMetatileAt(grid: FireRedMapGrid, x: number, y: number): number {
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
export const FIRERED_DIRECTION_STEPS = {
  north: { dx: 0, dy: -1 },
  south: { dx: 0, dy: 1 },
  west: { dx: -1, dy: 0 },
  east: { dx: 1, dy: 0 },
} as const;

export type FireRedDirection = keyof typeof FIRERED_DIRECTION_STEPS;

export interface FireRedTileView {
  x: number;
  y: number;
  /** False for border filler as well as for walls, so it is safe to act on. */
  passable: boolean;
  /** Null outside the loaded map, where no tile genuinely exists. */
  elevation: number | null;
  metatileId: number | null;
}

export interface FireRedSurroundings {
  north: FireRedTileView;
  east: FireRedTileView;
  south: FireRedTileView;
  west: FireRedTileView;
  /** The tile the player is facing — the one A would interact with. */
  ahead: FireRedTileView;
}

export function fireRedTileView(grid: FireRedMapGrid, x: number, y: number): FireRedTileView {
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
): FireRedSurroundings {
  const at = (direction: FireRedDirection): FireRedTileView => {
    const step = FIRERED_DIRECTION_STEPS[direction];
    return fireRedTileView(grid, x + step.dx, y + step.dy);
  };
  return { north: at("north"), east: at("east"), south: at("south"), west: at("west"), ahead: at(facing) };
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
