// Standalone needs-human signpost candidate preview (VUH-515 taste review).
//
// Renders CANDIDATE signpost art for the owner's review — a wooden post + board
// planted at the stump, in three ref-lettering treatments (number-only, prefix
// over number, and a tinted tab + number) plus a "queue at the stump" strip. It
// is NOT on the shared generator path and writes nothing under assets/garden-atlas:
// nothing here is baked into the atlas. The app renders a flat
// placeholder post until a treatment is signed off and drawn into the atlas.
//
// It carries its own copies of the PNG encoder / canvas / 3x5 pixel-font (like
// preview-biomes.mjs) and reuses only palette.mjs colors.
//
// Run: node scripts/garden-sprites/preview-signposts.mjs [out.png]

import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PALETTE, GARDEN_BACKGROUND } from "./palette.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_PNG = process.argv[2] || path.join(SCRIPT_DIR, "signposts-preview.png");

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

function blitFrame(sheet, rows, ox, oy, scale) {
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const ch = rows[y][x];
      if (ch === ".") continue;
      const rgba = PALETTE[ch];
      if (!rgba) throw new Error(`unknown palette key '${ch}' at row ${y} col ${x}`);
      fillRect(sheet, ox + x * scale, oy + y * scale, scale, scale, [rgba[0], rgba[1], rgba[2], 255]);
    }
  }
}

// --- 3x5 pixel font (copy of generate.mjs, digits/letters only) -------------

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
  // Trailing char has no advance gap in practice; keep the simple 4px advance.
  return text.length * 4 * scale;
}

// --- Signpost art ------------------------------------------------------------
// One post shape shared across lettering treatments: a wooden board (cream field
// 'f', warm-brown 'o' frame) on a mid-brown 'm' stake, on a small 'D' dirt mound.
// The board's cream interior is the region the ref lettering sits in.
const BOARD_W = 22; // outer board width in source px
const BOARD_H = 15; // outer board height
const POST_H = 9;
const MOUND_H = 2;
const SPRITE_W = BOARD_W;
const SPRITE_H = BOARD_H + POST_H + MOUND_H;

/** Build the bare post sprite grid (no lettering) as palette-key rows. */
function postGrid() {
  const rows = [];
  for (let y = 0; y < BOARD_H; y++) {
    if (y === 0 || y === BOARD_H - 1) {
      rows.push("o".repeat(BOARD_W));
    } else {
      rows.push("o" + "f".repeat(BOARD_W - 2) + "o");
    }
  }
  const stakeL = Math.floor((BOARD_W - 4) / 2);
  for (let y = 0; y < POST_H; y++) {
    let row = "";
    for (let x = 0; x < BOARD_W; x++) {
      if (x === stakeL || x === stakeL + 3) row += "o";
      else if (x === stakeL + 1 || x === stakeL + 2) row += "m";
      else row += ".";
    }
    rows.push(row);
  }
  for (let y = 0; y < MOUND_H; y++) {
    const inset = 6 - y * 2;
    let row = "";
    for (let x = 0; x < BOARD_W; x++) row += x >= inset && x < BOARD_W - inset ? "D" : ".";
    rows.push(row);
  }
  return rows;
}

const OUTLINE = PALETTE.o;
// Flat accent tabs (mirrors the app's placeholder per-ref label tint).
const ACCENTS = { teal: PALETTE.T, amber: PALETTE.G, dusk: PALETTE.U };

/** Board interior box in source px, for centering lettering. */
const INTERIOR = { x: 1, y: 1, w: BOARD_W - 2, h: BOARD_H - 2 };

/** Draw a signpost with a lettering treatment for `ref` (e.g. "VUH-489"). */
function drawSignpost(cv, ox, oy, scale, ref, treatment) {
  blitFrame(cv, postGrid(), ox, oy, scale);
  const [prefix, num] = ref.split("-");
  const cx = ox + INTERIOR.x * scale;
  const cy = oy + INTERIOR.y * scale;
  const cw = INTERIOR.w * scale;
  const ch = INTERIOR.h * scale;
  const center = (text, s) => cx + Math.max(0, Math.floor((cw - textWidth(text, s)) / 2));

  if (treatment === "number") {
    // Number-only: the biggest, most legible single token on a small sign.
    const s = scale;
    drawText(cv, center(num, s), cy + Math.floor((ch - 5 * s) / 2), num, s, OUTLINE);
  } else if (treatment === "stacked") {
    // Prefix over number: carries the full ref, two small lines.
    const s = scale;
    const lineH = 5 * s;
    const gap = 1 * s;
    const top = cy + Math.floor((ch - (lineH * 2 + gap)) / 2);
    drawText(cv, center(prefix, s), top, prefix, s, OUTLINE);
    drawText(cv, center(num, s), top + lineH + gap, num, s, OUTLINE);
  } else if (treatment === "tab") {
    // Tinted tab (per-ref accent, like the app placeholder) + number.
    const tabH = 4 * scale;
    fillRect(cv, cx, cy, cw, tabH, ACCENTS.dusk);
    const s = scale;
    drawText(cv, center(num, s), cy + tabH + Math.floor((ch - tabH - 5 * s) / 2), num, s, OUTLINE);
  }
}

// --- Layout ------------------------------------------------------------------

const SCALE = 9;
const TITLE_SCALE = 3;
const LABEL_SCALE = 2;
const PAD = 18;
const GAP = 22;
const cream = PALETTE.f;
const rimGray = PALETTE.q;

const treatments = [
  { key: "number", label: "A NUMBER ONLY" },
  { key: "stacked", label: "B PREFIX OVER NUMBER" },
  { key: "tab", label: "C ACCENT TAB PLUS NUMBER" },
];
const SAMPLE = "VUH-489";
const QUEUE = ["VUH-489", "VUH-502", "ENG-12"];

const spriteW = SPRITE_W * SCALE;
const spriteH = SPRITE_H * SCALE;
const labelH = 5 * LABEL_SCALE + 8;
const cellW = spriteW + GAP;

const titleH = 5 * TITLE_SCALE + 10;
const rowLabelH = 5 * LABEL_SCALE + 10;

const sheetW = PAD * 2 + Math.max(treatments.length, QUEUE.length) * cellW;
const sheetH = PAD * 2 + titleH + GAP + (rowLabelH + spriteH + labelH + GAP) + (rowLabelH + spriteH + labelH);

const sheet = makeCanvas(sheetW, sheetH, SLATE);

drawText(sheet, PAD, PAD, "NEEDS-HUMAN SIGNPOSTS - VUH-515 - CANDIDATES", TITLE_SCALE, cream);

// Row 1: three lettering treatments of the same ref.
let y = PAD + titleH + GAP;
drawText(sheet, PAD, y, "LETTERING TREATMENTS - SAMPLE " + SAMPLE, LABEL_SCALE, cream);
fillRect(sheet, PAD, y + 5 * LABEL_SCALE + 3, sheetW - PAD * 2, 1, rimGray);
let top = y + rowLabelH;
treatments.forEach((t, i) => {
  const ox = PAD + i * cellW;
  drawSignpost(sheet, ox, top, SCALE, SAMPLE, t.key);
  const lw = textWidth(t.label, LABEL_SCALE);
  drawText(sheet, ox + Math.floor((spriteW - lw) / 2), top + spriteH + 5, t.label, LABEL_SCALE, cream);
});

// Row 2: a queue of signposts planted at the stump (the default = stacked).
y = top + spriteH + labelH + GAP;
drawText(sheet, PAD, y, "QUEUE AT THE STUMP - STACKED DEFAULT", LABEL_SCALE, cream);
fillRect(sheet, PAD, y + 5 * LABEL_SCALE + 3, sheetW - PAD * 2, 1, rimGray);
top = y + rowLabelH;
QUEUE.forEach((ref, i) => {
  const ox = PAD + i * cellW;
  drawSignpost(sheet, ox, top, SCALE, ref, "stacked");
  const lw = textWidth(ref, LABEL_SCALE);
  drawText(sheet, ox + Math.floor((spriteW - lw) / 2), top + spriteH + 5, ref, LABEL_SCALE, cream);
});

fs.writeFileSync(OUT_PNG, encodePNG(sheet.width, sheet.height, sheet.buf));
console.log(`signpost candidates: ${OUT_PNG}  ${sheetW}x${sheetH}`);
console.log(`treatments: ${treatments.map((t) => t.label).join(", ")}`);
