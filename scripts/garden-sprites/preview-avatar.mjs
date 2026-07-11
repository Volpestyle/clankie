// Standalone AVATAR + watering-can candidate preview (VUH-539 taste review).
//
// Renders the tap-to-move AVATAR's identity art for the owner's review: the gold-1
// leaf guy (idle0 tinted via VARIANT_TINTS.gold) and his neutral tin/pewter
// watering can composited at the avatar-accessory anchor, at a bracket of garden
// zooms — so the reviewer can confirm the can is "stubby + accent visible at garden
// zoom" while the leaf guy stays the read, plus a large detail of the can alone.
//
// NOT on the shared generator path and writes nothing under assets/garden-atlas:
// nothing here is baked into the atlas. `pnpm garden:atlas` bakes the
// gold variant + `wateringCan` frame once the art is signed off. Carries its own
// PNG encoder / canvas / 3x5 font (like the other preview-*.mjs) and reuses only
// palette.mjs colors + the real frames.mjs grids.
//
// Run: node scripts/garden-sprites/preview-avatar.mjs [out.png]

import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PALETTE, VARIANT_TINTS, GARDEN_BACKGROUND } from "./palette.mjs";
import { FRAMES } from "./frames.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_PNG = process.argv[2] || path.join(SCRIPT_DIR, "avatar-preview.png");

// Body-local top-left where the avatar's watering can rides (matches
// AVATAR_ACCESSORY_ANCHOR in GardenCanvas.tsx — kept in sync by hand). Low on the
// body so it never occludes the sprout or face; reads as carried at his side.
const AVATAR_ACCESSORY_ANCHOR = { x: 13, y: 16 };
const CHAR_W = 24;
const CHAR_H = 28;

// --- PNG encoder (standalone copy) ------------------------------------------

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

/** Blit a rows[] grid at (ox,oy) × scale, optionally swapping l/g to a tint. */
function blitFrame(cv, rows, ox, oy, scale, tint) {
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const ch = rows[y][x];
      if (ch === ".") continue;
      let rgba = PALETTE[ch];
      if (tint && (ch === "l" || ch === "g")) rgba = ch === "l" ? tint.l : tint.g;
      if (!rgba) throw new Error(`unknown palette key '${ch}' at row ${y} col ${x}`);
      fillRect(cv, ox + x * scale, oy + y * scale, scale, scale, [rgba[0], rgba[1], rgba[2], 255]);
    }
  }
}

/** Draw the gold avatar (idle0) + his watering can, top-left at (ox,oy) × scale. */
function drawAvatar(cv, ox, oy, scale, withCan) {
  blitFrame(cv, FRAMES.idle0, ox, oy, scale, VARIANT_TINTS.gold);
  if (withCan) {
    blitFrame(
      cv,
      FRAMES.wateringCan,
      ox + AVATAR_ACCESSORY_ANCHOR.x * scale,
      oy + AVATAR_ACCESSORY_ANCHOR.y * scale,
      scale,
    );
  }
}

// --- 3x5 pixel font (standalone copy) ---------------------------------------

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
      for (let r = 0; r < 5; r++)
        for (let c = 0; c < 3; c++)
          if (g[r][c] === "#") fillRect(cv, cx + c * scale, y + r * scale, scale, scale, rgba);
    }
    cx += 4 * scale;
  }
}
// --- layout -----------------------------------------------------------------

const TITLE_SCALE = 3;
const LABEL_SCALE = 2;
const PAD = 18;
const cream = PALETTE.f;
const rimGray = PALETTE.q;
const titleH = 5 * TITLE_SCALE + 12;
const rowLabelH = 5 * LABEL_SCALE + 10;

// Garden-zoom bracket: base sprite scale × the camera's 0.5×–3× zoom band lands the
// avatar roughly in the 3×–8× device-pixel range. Show that spread.
const ZOOMS = [3, 5, 8];

const sheetW = 760;
const sheetH = 620;
const sheet = makeCanvas(sheetW, sheetH, SLATE);

drawText(sheet, PAD, PAD, "AVATAR ART - VUH-539 - GOLD-1 LEAF GUY + WATERING CAN", TITLE_SCALE, cream);

// Row 1: avatar + can at the garden-zoom bracket, on the slate.
let y = PAD + titleH + 8;
drawText(sheet, PAD, y, "AT GARDEN ZOOM - CAN VISIBLE, LEAF GUY STAYS THE READ", LABEL_SCALE, cream);
fillRect(sheet, PAD, y + 5 * LABEL_SCALE + 3, sheetW - PAD * 2, 1, rimGray);
let top = y + rowLabelH;
let x = PAD;
for (const s of ZOOMS) {
  drawAvatar(sheet, x, top, s, true);
  drawText(sheet, x, top + CHAR_H * s + 6, `${s}X`, LABEL_SCALE, cream);
  x += CHAR_W * s + 40;
}

// Row 2: gold avatar alone vs with can (medium zoom), for the figure-ground read.
y = top + CHAR_H * 8 + 40;
drawText(sheet, PAD, y, "GOLD LEAF (NO CAN)   vs   WITH CAN", LABEL_SCALE, cream);
fillRect(sheet, PAD, y + 5 * LABEL_SCALE + 3, sheetW - PAD * 2, 1, rimGray);
top = y + rowLabelH;
const S_MED = 6;
drawAvatar(sheet, PAD, top, S_MED, false);
drawAvatar(sheet, PAD + CHAR_W * S_MED + 60, top, S_MED, true);

// Row 3: the watering can alone, large, for the tin/gold/outline detail.
const S_BIG = 14;
const canX = PAD + CHAR_W * S_MED * 2 + 140;
drawText(sheet, canX, y, "WATERING CAN DETAIL", LABEL_SCALE, cream);
blitFrame(sheet, FRAMES.wateringCan, canX, top, S_BIG);
drawText(sheet, canX, top + 12 * S_BIG + 8, "SPOUT + BODY + HANDLE - GOLD BAND", LABEL_SCALE, cream);

fs.writeFileSync(OUT_PNG, encodePNG(sheet.width, sheet.height, sheet.buf));
console.log(`avatar preview: ${OUT_PNG}  ${sheetW}x${sheetH}`);
console.log(
  `gold tint l=#f0d696 g=#c9a34e · can: tin body + gold marker band, spout + C-handle · anchor (${AVATAR_ACCESSORY_ANCHOR.x},${AVATAR_ACCESSORY_ANCHOR.y})`,
);
