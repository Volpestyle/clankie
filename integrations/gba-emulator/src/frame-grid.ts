/**
 * Tile coordinates drawn onto a game frame.
 *
 * He has had the screenshot since the beginning — the mind attaches it every
 * turn, and it works: on 2026-08-18 he wrote "three balls on screen" while
 * standing next to Oak's starter table. What he could not do was *address* it.
 * `walk_to` takes `(x, y)`, nothing on the picture says which pixel is which
 * tile, so seeing the table turned into guessing a coordinate: he tried
 * (18,10), walked onto bare floor, pressed A at nothing, and spent 66 turns in
 * one room getting a starter.
 *
 * The gap is a coordinate frame, not more vision and not a richer decode. The
 * camera is player-locked — the map carries a 7-tile border (see
 * `FIRERED_MAP_BORDER_OFFSET`) precisely so it never has to clamp at an edge —
 * so the tile under any pixel is a fixed offset from where he stands. Labelled
 * axes in a margin turn "over there" into "(17,9)" for every object on every
 * map, including the ones no RAM decoder was ever taught to name.
 *
 * Labels live in an added margin rather than on the picture — the frame is also
 * what the room watches (ADR 0047), and a number stamped across the sprite he
 * is trying to read would trade one audience's problem for another's. The rules
 * themselves do cross the game, because a grid that does not is not a grid.
 */

/** Screen tile the player sprite stands on, measured from two live frames. */
export const PLAYER_SCREEN_COLUMN = 7;
export const PLAYER_SCREEN_ROW = 4;
/** GBA overworld tiles are 16x16 device pixels. */
export const TILE_PIXELS = 16;

export interface FrameGridAnchor {
  /** Map coordinate of the tile the player is standing on. */
  readonly playerX: number;
  readonly playerY: number;
  /** Overridable for a body whose camera is not player-locked. */
  readonly playerColumn?: number;
  readonly playerRow?: number;
}

/** 3x5 glyphs, one bit per pixel, row-major from the top. Digits and a minus. */
const GLYPHS: Readonly<Record<string, readonly number[]>> = {
  "0": [0b111, 0b101, 0b101, 0b101, 0b111],
  "1": [0b010, 0b110, 0b010, 0b010, 0b111],
  "2": [0b111, 0b001, 0b111, 0b100, 0b111],
  "3": [0b111, 0b001, 0b111, 0b001, 0b111],
  "4": [0b101, 0b101, 0b111, 0b001, 0b001],
  "5": [0b111, 0b100, 0b111, 0b001, 0b111],
  "6": [0b111, 0b100, 0b111, 0b101, 0b111],
  "7": [0b111, 0b001, 0b010, 0b010, 0b010],
  "8": [0b111, 0b101, 0b111, 0b101, 0b111],
  "9": [0b111, 0b101, 0b111, 0b001, 0b111],
  "-": [0b000, 0b000, 0b111, 0b000, 0b000],
};
const GLYPH_WIDTH = 3;
const GLYPH_HEIGHT = 5;

/** Margin in device pixels, before scaling. Two 3x5 digits plus breathing room. */
const MARGIN_PIXELS = 11;

const INK: readonly [number, number, number] = [255, 255, 255];
const PAPER: readonly [number, number, number] = [24, 24, 32];
const RULE: readonly [number, number, number] = [90, 90, 110];
const PLAYER_RULE: readonly [number, number, number] = [220, 80, 80];

/** An RGB canvas addressed in device pixels; `scale` maps it to output pixels. */
export interface GridCanvas {
  readonly rgb: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * Wrap an upscaled RGB frame in a labelled tile grid.
 *
 * `frame` is the already-scaled game picture. The returned canvas is larger by
 * one margin on the top and left; the game pixels are copied across untouched.
 */
export function drawTileGrid(frame: GridCanvas, scale: number, anchor: FrameGridAnchor): GridCanvas {
  const margin = MARGIN_PIXELS * scale;
  const tile = TILE_PIXELS * scale;
  const width = frame.width + margin;
  const height = frame.height + margin;
  const rgb = new Uint8Array(width * height * 3);
  paint(rgb, width, 0, 0, width, height, PAPER);
  for (let y = 0; y < frame.height; y += 1) {
    const from = y * frame.width * 3;
    rgb.set(frame.rgb.subarray(from, from + frame.width * 3), ((y + margin) * width + margin) * 3);
  }

  const column0 = anchor.playerX - (anchor.playerColumn ?? PLAYER_SCREEN_COLUMN);
  const row0 = anchor.playerY - (anchor.playerRow ?? PLAYER_SCREEN_ROW);
  const columns = Math.floor(frame.width / tile);
  const rows = Math.floor(frame.height / tile);

  for (let column = 0; column <= columns; column += 1) {
    const x = margin + column * tile;
    if (x >= width) break;
    const onPlayer = column === (anchor.playerColumn ?? PLAYER_SCREEN_COLUMN);
    // One device pixel is invisible once upscaled; a rule has to scale with
    // the picture or the grid it describes cannot be read off the picture.
    paint(rgb, width, x, margin, scale, height - margin, onPlayer ? PLAYER_RULE : RULE);
    if (column < columns) label(rgb, width, x + 2 * scale, 2 * scale, scale, String(column0 + column));
  }
  for (let row = 0; row <= rows; row += 1) {
    const y = margin + row * tile;
    if (y >= height) break;
    const onPlayer = row === (anchor.playerRow ?? PLAYER_SCREEN_ROW);
    paint(rgb, width, margin, y, width - margin, scale, onPlayer ? PLAYER_RULE : RULE);
    if (row < rows) label(rgb, width, 2 * scale, y + 2 * scale, scale, String(row0 + row));
  }
  return { rgb, width, height };
}

function paint(
  rgb: Uint8Array,
  width: number,
  x: number,
  y: number,
  spanX: number,
  spanY: number,
  color: readonly [number, number, number],
): void {
  for (let row = y; row < y + spanY; row += 1) {
    for (let column = x; column < x + spanX; column += 1) {
      const at = (row * width + column) * 3;
      if (at < 0 || at + 2 >= rgb.length) continue;
      rgb[at] = color[0];
      rgb[at + 1] = color[1];
      rgb[at + 2] = color[2];
    }
  }
}

function label(rgb: Uint8Array, width: number, x: number, y: number, scale: number, text: string): void {
  let cursor = x;
  for (const character of text) {
    const glyph = GLYPHS[character];
    if (glyph === undefined) continue;
    for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
      const bits = glyph[row] ?? 0;
      for (let column = 0; column < GLYPH_WIDTH; column += 1) {
        if ((bits & (1 << (GLYPH_WIDTH - 1 - column))) === 0) continue;
        paint(rgb, width, cursor + column * scale, y + row * scale, scale, scale, INK);
      }
    }
    cursor += (GLYPH_WIDTH + 1) * scale;
  }
}
