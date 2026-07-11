// Standalone skill-totem / lead-badge preview renderer (VUH-621 / VUH-538 taste
// review). Renders ONLY totems.mjs art: the bare totem, the totem with each skill
// glyph carved on its face, every glyph large, and the lead circlet alone + worn
// on a mock leaf-guy head. Nearest-neighbor upscaled on the garden slate.
//
// Deliberately NOT on the shared generator path (importing generate.mjs would run
// the gated atlas build): it reuses totems.mjs's self-contained grids + palette.mjs
// and the frames.mjs idle pose (for the crown-worn mock), and carries its own copy
// of the PNG encoder / canvas / pixel-font from generate.mjs.
//
// Run: node scripts/garden-sprites/preview-totems.mjs [out.png]

import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PALETTE, GARDEN_BACKGROUND } from "./palette.mjs";
import { TOTEM_FRAMES, TOTEM_GLYPH_ANCHOR, SKILL_GLYPH_ORDER, LEAD_CROWN_ANCHOR } from "./totems.mjs";
import { FRAMES as BASE_FRAMES } from "./frames.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_PNG = process.argv[2] || path.join(SCRIPT_DIR, "totems-preview.png");

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

const SCALE = 8;
const LABEL_SCALE = 2;
const TITLE_SCALE = 3;
const PAD = 16;
const GAP = 12;
const labelH = 5 * LABEL_SCALE + 6;
const titleH = 5 * TITLE_SCALE + 10;
const cream = PALETTE.f;
const rimGray = PALETTE.q;

const totemRows = TOTEM_FRAMES.totem;
const totemDim = frameDims("totem", totemRows);
const glyphDims = {};
for (const g of SKILL_GLYPH_ORDER) glyphDims[g] = frameDims(g, TOTEM_FRAMES[g]);
const crownRows = TOTEM_FRAMES.leadCrown;
const crownDim = frameDims("leadCrown", crownRows);

// Row 1: totem carved with each glyph (+ bare totem first).
const totemCellW = totemDim.w * SCALE + GAP + 6;
const totemCellH = totemDim.h * SCALE + labelH + GAP;
const totemCount = SKILL_GLYPH_ORDER.length + 1;

// Row 2: each glyph large (on a cream swatch, as it reads on the face).
const glyphSwatch = 8 * SCALE;
const glyphCellW = glyphSwatch + GAP + 6;
const glyphCellH = glyphSwatch + labelH + GAP;

// Row 3: crown alone + worn on a mock idle head.
const idle = BASE_FRAMES.idle0;
const idleDim = frameDims("idle0", idle);
const wornCellH = idleDim.h * SCALE + labelH + GAP;

const cols = Math.max(totemCount, SKILL_GLYPH_ORDER.length);
const sheetW = PAD * 2 + Math.max(cols * totemCellW, cols * glyphCellW);
const sheetH =
  PAD * 2 +
  titleH +
  GAP +
  (5 * TITLE_SCALE + 10) +
  totemCellH +
  GAP + // totems-with-glyph section
  (5 * TITLE_SCALE + 10) +
  glyphCellH +
  GAP + // glyph vocabulary section
  (5 * TITLE_SCALE + 10) +
  wornCellH +
  GAP; // lead badge section

const sheet = makeCanvas(sheetW, sheetH, SLATE);

drawText(sheet, PAD, PAD, "GARDEN SKILL TOTEMS + LEAD BADGE - VUH-621 / VUH-538", TITLE_SCALE, cream);

let y = PAD + titleH + GAP;

// --- section 1: totem carved with each skill glyph --------------------------
drawText(sheet, PAD, y, "TOTEM + PER-SKILL GLYPH (BARE, THEN CARVED)", TITLE_SCALE, cream);
fillRect(sheet, PAD, y + 5 * TITLE_SCALE + 4, totemCount * totemCellW - GAP, 1, rimGray);
let secTop = y + 5 * TITLE_SCALE + 10;
{
  const baseline = secTop + totemDim.h * SCALE;
  const cells = ["(bare)", ...SKILL_GLYPH_ORDER];
  cells.forEach((label, i) => {
    const cx = PAD + i * totemCellW;
    const ox = cx + Math.floor((totemDim.w * SCALE + 6 - totemDim.w * SCALE) / 2);
    const oy = baseline - totemDim.h * SCALE;
    blitFrame(sheet, totemRows, ox, oy, SCALE);
    if (i > 0) {
      blitFrame(
        sheet,
        TOTEM_FRAMES[label],
        ox + TOTEM_GLYPH_ANCHOR.x * SCALE,
        oy + TOTEM_GLYPH_ANCHOR.y * SCALE,
        SCALE,
      );
    }
    const lw = textWidth(label.toUpperCase(), LABEL_SCALE);
    drawText(
      sheet,
      cx + Math.floor((totemDim.w * SCALE + 6 - lw) / 2),
      baseline + 4,
      label.toUpperCase(),
      LABEL_SCALE,
      cream,
    );
  });
}
y = secTop + totemCellH + GAP;

// --- section 2: glyph vocabulary large, on cream ----------------------------
drawText(sheet, PAD, y, "SKILL GLYPH VOCABULARY (ON CREAM FACE)", TITLE_SCALE, cream);
fillRect(sheet, PAD, y + 5 * TITLE_SCALE + 4, SKILL_GLYPH_ORDER.length * glyphCellW - GAP, 1, rimGray);
secTop = y + 5 * TITLE_SCALE + 10;
SKILL_GLYPH_ORDER.forEach((g, i) => {
  const cx = PAD + i * glyphCellW;
  const ox = cx + 3;
  const oy = secTop;
  // cream swatch behind the glyph (mimics the totem face).
  fillRect(sheet, ox, oy, glyphSwatch, glyphSwatch, [cream[0], cream[1], cream[2], 255]);
  blitFrame(sheet, TOTEM_FRAMES[g], ox, oy, SCALE);
  const lw = textWidth(g.toUpperCase(), LABEL_SCALE);
  drawText(
    sheet,
    cx + Math.floor((glyphSwatch + 6 - lw) / 2),
    secTop + glyphSwatch + 4,
    g.toUpperCase(),
    LABEL_SCALE,
    cream,
  );
});
y = secTop + glyphCellH + GAP;

// --- section 3: lead badge --------------------------------------------------
drawText(sheet, PAD, y, "LEAD BADGE - GOLD CIRCLET (ALONE, THEN WORN)", TITLE_SCALE, cream);
fillRect(sheet, PAD, y + 5 * TITLE_SCALE + 4, 4 * (idleDim.w * SCALE + GAP) - GAP, 1, rimGray);
secTop = y + 5 * TITLE_SCALE + 10;
{
  const baseline = secTop + idleDim.h * SCALE;
  // crown alone
  let cx = PAD;
  const crownOx = cx + Math.floor((idleDim.w * SCALE - crownDim.w * SCALE) / 2);
  blitFrame(sheet, crownRows, crownOx, secTop + 10 * SCALE, SCALE);
  drawText(sheet, cx, baseline + 4, "CIRCLET", LABEL_SCALE, cream);
  // worn on idle heads (green + a couple mock tints via straight base render)
  cx = PAD + (idleDim.w * SCALE + GAP);
  const ox = cx;
  blitFrame(sheet, idle, ox, secTop, SCALE);
  blitFrame(sheet, crownRows, ox + LEAD_CROWN_ANCHOR.x * SCALE, secTop + LEAD_CROWN_ANCHOR.y * SCALE, SCALE);
  drawText(sheet, cx, baseline + 4, "LEAD (WORN)", LABEL_SCALE, cream);
}

fs.writeFileSync(OUT_PNG, encodePNG(sheet.width, sheet.height, sheet.buf));
console.log(`totem preview: ${OUT_PNG}  ${sheetW}x${sheetH}`);
console.log(`glyphs: ${SKILL_GLYPH_ORDER.join(", ")}`);
