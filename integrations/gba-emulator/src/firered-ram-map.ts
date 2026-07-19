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
 * Reachability limitation (ADR 0040): the libretro memory API exposes only
 * EWRAM (`RETRO_MEMORY_SYSTEM_RAM`). IWRAM (0x03000000) — where FireRed keeps
 * the DMA-shifted `gSaveBlock1/2` pointers — is not reachable, so any field
 * that must be found through those pointers cannot be decoded through this
 * seam. The fields below live at fixed EWRAM addresses and need no pointer
 * chase.
 */

/** EWRAM offset of the player object's current tile coords (two s16 LE: x, y). */
export const FIRERED_PLAYER_COORDS_OFFSET = 0x36e48;
/** EWRAM offset of the player object's facing-direction byte. */
export const FIRERED_PLAYER_FACING_OFFSET = 0x36e58;
/** GBA EWRAM bus base address, for documentation of absolute addresses. */
export const GBA_EWRAM_BASE = 0x02000000;
export const GBA_EWRAM_SIZE = 0x40000;

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
