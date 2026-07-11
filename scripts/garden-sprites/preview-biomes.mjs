// Standalone biome-tile preview renderer (VUH-494 taste review).
//
// Renders ONLY the biome decoration sets from biomes.mjs — grouped by set,
// labeled with the exact frame name, nearest-neighbor upscaled on the garden
// slate — to a PNG for the taste officer. Deliberately NOT on the shared
// generator path (importing generate.mjs would run the gated atlas build):
// it reuses biomes.mjs's self-contained grids + palette.mjs, and carries its own
// copies of the PNG encoder / canvas / pixel-font from generate.mjs.
//
// Writes nothing under assets/garden-atlas. Output path is passed as
// argv[2] (defaults next to this script for local runs).
//
// Run: node scripts/garden-sprites/preview-biomes.mjs [out.png]

import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PALETTE, GARDEN_BACKGROUND } from "./palette.mjs";
import { BIOME_FRAMES, BIOME_SETS } from "./biomes.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_PNG = process.argv[2] || path.join(SCRIPT_DIR, "biomes-preview.png");

// --- PNG encoder (copy of generate.mjs; kept standalone on purpose) ---------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = 0;
    rgba.copy(raw, o + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- RGBA canvas ------------------------------------------------------------

function makeCanvas(width, height, fill) {
  const buf = Buffer.alloc(width * height * 4);
  if (fill) {
    for (let i = 0; i < width * height; i++) {
      buf[i * 4] = fill[0];
      buf[i * 4 + 1] = fill[1];
      buf[i * 4 + 2] = fill[2];
      buf[i * 4 + 3] = fill[3];
    }
  }
  return { width, height, buf };
}
function fillRect(cv, x0, y0, w, h, rgba) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) continue;
      const i = (y * cv.width + x) * 4;
      cv.buf[i] = rgba[0];
      cv.buf[i + 1] = rgba[1];
      cv.buf[i + 2] = rgba[2];
      cv.buf[i + 3] = rgba[3];
    }
  }
}

const hexBg = GARDEN_BACKGROUND.replace("#", "");
const SLATE = [
  parseInt(hexBg.slice(0, 2), 16),
  parseInt(hexBg.slice(2, 4), 16),
  parseInt(hexBg.slice(4, 6), 16),
  255,
];

// --- frame validation + rendering (loud on typos, like the generator) -------

function frameDims(name, rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`frame "${name}": no rows`);
  const w = rows[0].length;
  rows.forEach((row, y) => {
    if (typeof row !== "string" || row.length !== w) {
      throw new Error(`frame "${name}" row ${y}: width ${row?.length} != ${w}`);
    }
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch !== "." && !(ch in PALETTE)) {
        throw new Error(`frame "${name}" row ${y} col ${x}: unknown palette key '${ch}'`);
      }
    }
  });
  return { w, h: rows.length };
}

/** Blit a frame's rows into the sheet at (ox,oy), scaled nearest-neighbor. */
function blitFrame(sheet, rows, ox, oy, scale) {
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const ch = rows[y][x];
      if (ch === ".") continue;
      const rgba = PALETTE[ch];
      fillRect(sheet, ox + x * scale, oy + y * scale, scale, scale, [rgba[0], rgba[1], rgba[2], 255]);
    }
  }
}

// --- 3x5 pixel font (copy of generate.mjs) ----------------------------------

const FONT = {
  A: ["###", "# #", "###", "# #", "# #"],
  B: ["## ", "# #", "## ", "# #", "## "],
  C: ["###", "#  ", "#  ", "#  ", "###"],
  D: ["## ", "# #", "# #", "# #", "## "],
  E: ["###", "#  ", "###", "#  ", "###"],
  F: ["###", "#  ", "###", "#  ", "#  "],
  G: ["###", "#  ", "# #", "# #", "###"],
  H: ["# #", "# #", "###", "# #", "# #"],
  I: ["###", " # ", " # ", " # ", "###"],
  J: ["  #", "  #", "  #", "# #", "###"],
  K: ["# #", "# #", "## ", "# #", "# #"],
  L: ["#  ", "#  ", "#  ", "#  ", "###"],
  M: ["# #", "###", "###", "# #", "# #"],
  N: ["# #", "###", "###", "###", "# #"],
  O: ["###", "# #", "# #", "# #", "###"],
  P: ["###", "# #", "###", "#  ", "#  "],
  Q: ["###", "# #", "# #", "###", "  #"],
  R: ["## ", "# #", "## ", "# #", "# #"],
  S: ["###", "#  ", "###", "  #", "###"],
  T: ["###", " # ", " # ", " # ", " # "],
  U: ["# #", "# #", "# #", "# #", "###"],
  V: ["# #", "# #", "# #", "# #", " # "],
  W: ["# #", "# #", "###", "###", "# #"],
  X: ["# #", "# #", " # ", "# #", "# #"],
  Y: ["# #", "# #", " # ", " # ", " # "],
  Z: ["###", "  #", " # ", "#  ", "###"],
  0: ["###", "# #", "# #", "# #", "###"],
  1: [" # ", "## ", " # ", " # ", "###"],
  2: ["###", "  #", "###", "#  ", "###"],
  3: ["###", "  #", "###", "  #", "###"],
  4: ["# #", "# #", "###", "  #", "  #"],
  5: ["###", "#  ", "###", "  #", "###"],
  6: ["###", "#  ", "###", "# #", "###"],
  7: ["###", "  #", "  #", "  #", "  #"],
  8: ["###", "# #", "###", "# #", "###"],
  9: ["###", "# #", "###", "  #", "###"],
};
function drawText(cv, x, y, text, scale, rgba) {
  let cx = x;
  for (const raw of text.toUpperCase()) {
    if (raw === " ") {
      cx += 4 * scale;
      continue;
    }
    const g = FONT[raw];
    if (g) {
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 3; c++) {
          if (g[r][c] === "#") fillRect(cv, cx + c * scale, y + r * scale, scale, scale, rgba);
        }
      }
    }
    cx += 4 * scale;
  }
}
function textWidth(text, scale) {
  return text.length * 4 * scale;
}

// --- layout -----------------------------------------------------------------

const SCALE = 8; // sprite upscale (contact sheet uses 6; a touch bigger for review)
const LABEL_SCALE = 2;
const TITLE_SCALE = 3;
const PAD = 14;
const GAP = 10;
const labelH = 5 * LABEL_SCALE + 6;
const titleH = 5 * TITLE_SCALE + 8;

const cream = PALETTE.f;
const rimGray = PALETTE.q;

// Validate + measure every biome frame up front (loud on typos).
const dims = {};
for (const [name, rows] of Object.entries(BIOME_FRAMES)) dims[name] = frameDims(name, rows);

// Cell sized to the largest biome tile so relative sizes read true across a row.
const cellMaxW = Math.max(...Object.values(dims).map((d) => d.w)) * SCALE;
const cellMaxH = Math.max(...Object.values(dims).map((d) => d.h)) * SCALE;
const cellW = cellMaxW + GAP;
const cellH = cellMaxH + labelH + GAP;
const cols = Math.max(...BIOME_SETS.map((s) => s.tiles.length + s.anchors.length));

const headerH = 5 * TITLE_SCALE + 12; // biome title strip
const rowH = headerH + cellH + GAP;

const sheetW = PAD * 2 + cols * cellW;
const sheetH = PAD * 2 + titleH + GAP + BIOME_SETS.length * rowH;

const sheet = makeCanvas(sheetW, sheetH, SLATE);

// Sheet title.
drawText(sheet, PAD, PAD, "GARDEN BIOME TILES - VUH-494 - ALL SETS", TITLE_SCALE, cream);

let y = PAD + titleH + GAP;
for (const set of BIOME_SETS) {
  // Biome title + a thin rim underline the width of its cells.
  drawText(sheet, PAD, y, set.label, TITLE_SCALE, cream);
  const names = [...set.tiles, ...set.anchors];
  fillRect(sheet, PAD, y + 5 * TITLE_SCALE + 4, names.length * cellW - GAP, 1, rimGray);

  const cellTop = y + headerH;
  names.forEach((name, i) => {
    const d = dims[name];
    const cx = PAD + i * cellW;
    // Bottom-align tiles on a shared baseline so ground decorations sit on a line.
    const ox = cx + Math.floor((cellMaxW - d.w * SCALE) / 2);
    const oy = cellTop + (cellMaxH - d.h * SCALE);
    blitFrame(sheet, BIOME_FRAMES[name], ox, oy, SCALE);
    // Name label centered under the cell (as it appears in atlas.gen.ts).
    const lw = textWidth(name.toUpperCase(), LABEL_SCALE);
    drawText(
      sheet,
      cx + Math.floor((cellMaxW - lw) / 2),
      cellTop + cellMaxH + 4,
      name.toUpperCase(),
      LABEL_SCALE,
      cream,
    );
  });

  y += rowH;
}

fs.writeFileSync(OUT_PNG, encodePNG(sheet.width, sheet.height, sheet.buf));
console.log(`biome preview: ${OUT_PNG}  ${sheetW}x${sheetH}`);
console.log(`sets: ${BIOME_SETS.map((s) => `${s.label}(${s.tiles.length}+${s.anchors.length})`).join(", ")}`);
