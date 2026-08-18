import { describe, expect, it } from "vitest";

import {
  drawTileGrid,
  PLAYER_SCREEN_COLUMN,
  PLAYER_SCREEN_ROW,
  TILE_PIXELS,
  type GridCanvas,
} from "../src/frame-grid.ts";

const SCALE = 3;
const MARGIN = 11 * SCALE;

function blankFrame(): GridCanvas {
  const width = 240 * SCALE;
  const height = 160 * SCALE;
  return { rgb: new Uint8Array(width * height * 3), width, height };
}

function pixel(canvas: GridCanvas, x: number, y: number): [number, number, number] {
  const at = (y * canvas.width + x) * 3;
  return [canvas.rgb[at] ?? 0, canvas.rgb[at + 1] ?? 0, canvas.rgb[at + 2] ?? 0];
}

describe("tile coordinates on the frame", () => {
  it("grows by one margin and keeps the picture between the rules", () => {
    const frame = blankFrame();
    // Mid-tile, so a margin or label that spilled onto the game would show.
    const inset = 20;
    frame.rgb.set([9, 9, 9], (inset * frame.width + inset) * 3);
    const gridded = drawTileGrid(frame, SCALE, { playerX: 13, playerY: 11 });
    expect(gridded.width).toBe(frame.width + MARGIN);
    expect(gridded.height).toBe(frame.height + MARGIN);
    expect(pixel(gridded, MARGIN + inset, MARGIN + inset)).toEqual([9, 9, 9]);
  });

  it("marks the tile he is standing on", () => {
    const gridded = drawTileGrid(blankFrame(), SCALE, { playerX: 13, playerY: 11 });
    const rule = MARGIN + PLAYER_SCREEN_COLUMN * TILE_PIXELS * SCALE;
    const [red, green, blue] = pixel(gridded, rule, MARGIN + 40);
    expect(red).toBeGreaterThan(green + 80);
    expect(red).toBeGreaterThan(blue + 80);
  });

  it("anchors the axes to where he stands, not to the screen", () => {
    // The same screen tile is a different map tile once he walks; the labels
    // are what carry that, so the origin has to move with him.
    const near = drawTileGrid(blankFrame(), SCALE, { playerX: 13, playerY: 11 });
    const far = drawTileGrid(blankFrame(), SCALE, { playerX: 40, playerY: 30 });
    expect(near.rgb).not.toEqual(far.rgb);
    // Column 0 of the visible screen is `playerX - PLAYER_SCREEN_COLUMN`.
    expect(13 - PLAYER_SCREEN_COLUMN).toBe(6);
    expect(11 - PLAYER_SCREEN_ROW).toBe(7);
  });

  it("accepts a body whose camera is not player-locked", () => {
    const shifted = drawTileGrid(blankFrame(), SCALE, {
      playerX: 13,
      playerY: 11,
      playerColumn: 0,
      playerRow: 0,
    });
    const rule = MARGIN;
    const [red, green] = pixel(shifted, rule, MARGIN + 40);
    expect(red).toBeGreaterThan(green + 80);
  });
});
