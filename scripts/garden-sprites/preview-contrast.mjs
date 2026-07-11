// Standalone sprite-on-ground CONTRAST strip (VUH-494 territory check).
//
// Renders each territory worker variant (its real, in-tree idle0 sprite, tinted
// per VARIANT_TINTS) standing among its biome's anchor + a ground tile, on the
// garden slate — to confirm the tinted sprite stays readable against its own
// ground (teal worker vs teal water, amber vs its field, dusk vs fern moss),
// plus meadow-only identities and the green dozer on Mushroom Grove.
//
// Standalone on purpose (does NOT import generate.mjs, which would run the gated
// atlas build): it composites the real frames.mjs / biomes.mjs grids with the
// sampled palette, carrying its own PNG encoder / canvas / font.
//
// Run: node scripts/garden-sprites/preview-contrast.mjs [out.png]

import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PALETTE, VARIANT_TINTS, GARDEN_BACKGROUND } from "./palette.mjs";
import { FRAMES } from "./frames.mjs";
import { BIOME_FRAMES } from "./biomes.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_PNG = process.argv[2] || path.join(SCRIPT_DIR, "contrast-strip.png");

// Territory scenes: variant sprite + its biome's anchor + one ground tile.
// The gold AVATAR (VUH-539) is not a harness worker — it has no biome — so it is
// checked on home Meadow (where it spawns and roams from), confirming the marker-
// gold leaf reads against the base ground and the dark slate.
// Meadow has no landmark anchor (the stump is its landmark), so the meadow scenes
// pair two meadow decorations instead — a fuller clover on the left, a tall tuft
// on the right — to read as "on the meadow ground".
const SCENES = [
  { variant: "green", label: "GREEN / MEADOW", anchor: "meadowClover", tile: "meadowTuftTall" },
  { variant: "teal", label: "TEAL / TIDEPOOLS", anchor: "tidePool", tile: "tideReed" },
  { variant: "amber", label: "AMBER / SUNFLOWER", anchor: "sunflowerTall", tile: "sunflowerStalk" },
  { variant: "dusk", label: "DUSK / FERN HOLLOW", anchor: "fernClump", tile: "fernFrond" },
  {
    variant: "onyx",
    label: "ONYX / DISCORD PRESENCE (MEADOW)",
    anchor: "meadowClover",
    tile: "meadowTuftTall",
  },
  { variant: "azure", label: "AZURE / GROK (MEADOW)", anchor: "meadowClover", tile: "meadowTuftTall" },
  { variant: "gold", label: "GOLD / AVATAR (HOME MEADOW)", anchor: "meadowClover", tile: "meadowTuftTall" },
  {
    variant: "green",
    label: "GREEN / MUSHROOM GROVE (DOZER)",
    anchor: "mushroomCluster",
    tile: "mushroomCap",
  },
];

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
function setPx(cv, x, y, rgba) {
  if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) return;
  const i = (y * cv.width + x) * 4;
  cv.buf[i] = rgba[0];
  cv.buf[i + 1] = rgba[1];
  cv.buf[i + 2] = rgba[2];
  cv.buf[i + 3] = rgba[3];
}
function fillRect(cv, x0, y0, w, h, rgba) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setPx(cv, x, y, rgba);
}
function blit(dst, src, dx, dy) {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const si = (y * src.width + x) * 4;
      if (src.buf[si + 3] === 0) continue;
      setPx(dst, dx + x, dy + y, [src.buf[si], src.buf[si + 1], src.buf[si + 2], src.buf[si + 3]]);
    }
  }
}
function blitScaled(dst, src, ox, oy, scale) {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const si = (y * src.width + x) * 4;
      if (src.buf[si + 3] === 0) continue;
      fillRect(dst, ox + x * scale, oy + y * scale, scale, scale, [
        src.buf[si],
        src.buf[si + 1],
        src.buf[si + 2],
        255,
      ]);
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

// --- render a frame (optionally variant-tinted: swap l/g like the generator) --

function renderFrame(rows, tint) {
  const w = rows[0].length;
  const h = rows.length;
  const cv = makeCanvas(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x];
      if (ch === ".") continue;
      let rgba = PALETTE[ch];
      if (tint && (ch === "l" || ch === "g")) rgba = ch === "l" ? tint.l : tint.g;
      if (!rgba) throw new Error(`unknown palette key '${ch}'`);
      setPx(cv, x, y, rgba);
    }
  }
  return cv;
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
// --- compose one scene: anchor | sprite | tile, bottom-aligned on a baseline --

function buildScene(scene) {
  const tint = VARIANT_TINTS[scene.variant];
  const sprite = renderFrame(FRAMES.idle0, tint);
  const anchor = renderFrame(BIOME_FRAMES[scene.anchor], null);
  const tile = renderFrame(BIOME_FRAMES[scene.tile], null);
  const margin = 2;
  const gap = 3;
  const w = margin + anchor.width + gap + sprite.width + gap + tile.width + margin;
  const h = margin + Math.max(sprite.height, anchor.height, tile.height) + margin;
  const cv = makeCanvas(w, h); // transparent
  const baseline = h - margin;
  let x = margin;
  blit(cv, anchor, x, baseline - anchor.height);
  x += anchor.width + gap;
  blit(cv, sprite, x, baseline - sprite.height);
  x += sprite.width + gap;
  blit(cv, tile, x, baseline - tile.height);
  return cv;
}

// --- layout -----------------------------------------------------------------

const SCALE = 7;
const LABEL_SCALE = 2;
const TITLE_SCALE = 3;
const PAD = 16;
const labelH = 5 * LABEL_SCALE + 4;
const titleH = 5 * TITLE_SCALE + 12;
const cream = PALETTE.f;

const scenes = SCENES.map((s) => ({ ...s, cv: buildScene(s) }));
const maxSceneW = Math.max(...scenes.map((s) => s.cv.width)) * SCALE;
const sheetW = PAD * 2 + maxSceneW;
const rowH = labelH + Math.max(...scenes.map((s) => s.cv.height)) * SCALE + PAD;
const sheetH = PAD + titleH + scenes.length * rowH + PAD;

const sheet = makeCanvas(sheetW, sheetH, SLATE);
drawText(sheet, PAD, PAD, "VUH-494 CONTRAST STRIP - VARIANT ON ITS GROUND", TITLE_SCALE, cream);

let y = PAD + titleH;
for (const s of scenes) {
  drawText(sheet, PAD, y, s.label, LABEL_SCALE, cream);
  blitScaled(sheet, s.cv, PAD, y + labelH, SCALE);
  y += rowH;
}

fs.writeFileSync(OUT_PNG, encodePNG(sheet.width, sheet.height, sheet.buf));
console.log(`contrast strip: ${OUT_PNG}  ${sheetW}x${sheetH}`);
console.log(`scenes: ${SCENES.map((s) => s.label).join(" | ")}`);
