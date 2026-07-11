// Garden sprite atlas generator — dependency-free (node:zlib only).
//
// Merges the base "leaf guy" grids (frames.mjs) with the phase-2 lifecycle poses
// + per-variant accessories (lifecycle.mjs) and the sampled palette (palette.mjs),
// then emits three artifacts:
//   1. assets/garden-atlas/leafguy-atlas.png — packed RGBA sprite atlas (transparent
//      background; the app composites it over GARDEN_BACKGROUND). Holds the green
//      base frames, the recolored per-variant body frames, and the accessories.
//   2. assets/garden-atlas/atlas.gen.ts  — generated frame/animation/variant
//      metadata (contract consumed by the Garden renderer; do not edit by hand).
//   3. assets/garden-atlas/contact-sheet.png — every frame at 6x on the garden slate
//      plus a variant/accessory comparison band, for visual review.
//
// Harness variants (VUH-454): each non-green worker's body frames are rendered
// with the head sprout + chest clover 'l'/'g' cells swapped to the variant tint
// (palette.mjs VARIANT_TINTS). The carried leaf on the carry poses is held green
// (the top contiguous l/g band of a carry frame). Frames with no tinted pixels
// (e.g. poof) are de-duplicated back onto the green rect.
//
// The PNG encoder is hand-rolled: 8-bit RGBA (color type 6), a single IDAT of
// filter-0 scanlines deflated with node:zlib, plus CRC32-checked IHDR/IDAT/IEND.
//
// Run: node scripts/garden-sprites/generate.mjs   (pnpm garden:atlas)

import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PALETTE, GARDEN_BACKGROUND, VARIANT_TINTS, VARIANTS } from "./palette.mjs";
import {
  FRAMES as BASE_FRAMES,
  FRAME_ORDER as BASE_FRAME_ORDER,
  ANIMATIONS as BASE_ANIMATIONS,
} from "./frames.mjs";
import { LIFECYCLE_FRAMES, LIFECYCLE_FRAME_ORDER, LIFECYCLE_ANIMATIONS, ACCESSORIES } from "./lifecycle.mjs";
import { BIOME_FRAMES, BIOME_FRAME_ORDER, BIOME_SETS } from "./biomes.mjs";
import {
  TOTEM_FRAMES,
  TOTEM_FRAME_ORDER,
  TOTEM_GLYPH_ANCHOR,
  SKILL_GLYPH_ORDER,
  LEAD_CROWN_ANCHOR,
} from "./totems.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(SCRIPT_DIR, "../..");
// VUH-709 can relocate all generated artifacts by changing this one constant.
const OUTPUT_DIR = path.join(REPO_DIR, "assets/garden-atlas");
const ATLAS_PNG = path.join(OUTPUT_DIR, "leafguy-atlas.png");
const CONTACT_PNG = path.join(OUTPUT_DIR, "contact-sheet.png");
const ATLAS_TS = path.join(OUTPUT_DIR, "atlas.gen.ts");

// Merge base + lifecycle + biome + totem sources into one frame/animation set.
// Biome tiles (VUH-494), skill-totem art (VUH-621), and the lead badge (VUH-538)
// are all props: packed + emitted like stump/jobsite, never variant-tinted (they
// are absent from BODY_FRAME_NAMES below).
const FRAMES = { ...BASE_FRAMES, ...LIFECYCLE_FRAMES, ...BIOME_FRAMES, ...TOTEM_FRAMES };
const FRAME_ORDER = [
  ...BASE_FRAME_ORDER,
  ...LIFECYCLE_FRAME_ORDER,
  ...BIOME_FRAME_ORDER,
  ...TOTEM_FRAME_ORDER,
];
const ANIMATIONS = { ...BASE_ANIMATIONS, ...LIFECYCLE_ANIMATIONS };

// Character poses that get per-variant recoloring — this IS GardenBodyFrameName.
const BODY_FRAME_NAMES = [
  "idle0",
  "idle1",
  "walk0",
  "walk1",
  "walk2",
  "walk3",
  "work0",
  "work1",
  "carry0",
  "carry1",
  "blocked0",
  "sleep0",
  "sleep1",
  "wilt0",
  "wilt1",
  "poof0",
  "poof1",
  "poof2",
];
// Poses that hold a green carried leaf (its top l/g band is never tinted).
const CARRY_FRAMES = new Set(["carry0", "carry1"]);

// Frames whose dimensions are fixed by the task spec; validated loudly so a
// mis-sized grid fails here rather than in the app.
const EXPECTED_DIMS = {
  idle0: [24, 28],
  idle1: [24, 28],
  walk0: [24, 28],
  walk1: [24, 28],
  walk2: [24, 28],
  walk3: [24, 28],
  work0: [24, 28],
  work1: [24, 28],
  carry0: [24, 28],
  carry1: [24, 28],
  blocked0: [24, 28],
  sleep0: [24, 28],
  sleep1: [24, 28],
  wilt0: [24, 28],
  wilt1: [24, 28],
  poof0: [24, 28],
  poof1: [24, 28],
  poof2: [24, 28],
  seed0: [12, 12],
  seed1: [12, 12],
  germinate0: [24, 28],
  germinate1: [24, 28],
  germinate2: [24, 28],
  seedSink0: [12, 12],
  seedSink1: [12, 12],
  stump: [48, 40],
  jobsite: [32, 16],
  leaf: [12, 10],
  wateringCan: [16, 12],
  signpost: [22, 26],
  glyphQ: [8, 10],
  glyphZ: [8, 10],
  glyphBang: [8, 10],
  glyphDots: [8, 10],
  "acc:teal": [8, 6],
  "acc:amber": [8, 6],
  "acc:dusk": [8, 6],
  // Skill-totem art (VUH-621) + lead badge (VUH-538): totem silhouette, seven
  // carved 8x8 skill glyphs (overlay the totem face), and the gold lead circlet.
  totem: [18, 26],
  leadCrown: [11, 5],
  skillStar: [8, 8],
  skillBolt: [8, 8],
  skillEye: [8, 8],
  skillArrow: [8, 8],
  skillDrop: [8, 8],
  skillLeaf: [8, 8],
  skillRing: [8, 8],
};

// ---------------------------------------------------------------------------
// PNG encoder (hand-rolled)
// ---------------------------------------------------------------------------

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

/** Encode an RGBA buffer (width*height*4 bytes) to a PNG Buffer. */
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = 0; // filter type 0 (none)
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

// ---------------------------------------------------------------------------
// Simple RGBA canvas
// ---------------------------------------------------------------------------

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

// Blit one canvas onto another, skipping fully-transparent source pixels.
function blit(dst, src, dx, dy) {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const si = (y * src.width + x) * 4;
      if (src.buf[si + 3] === 0) continue;
      setPx(dst, dx + x, dy + y, [src.buf[si], src.buf[si + 1], src.buf[si + 2], src.buf[si + 3]]);
    }
  }
}

// ---------------------------------------------------------------------------
// Frame validation + rendering
// ---------------------------------------------------------------------------

const hexBg = GARDEN_BACKGROUND.replace("#", "");
const SLATE = [
  parseInt(hexBg.slice(0, 2), 16),
  parseInt(hexBg.slice(2, 4), 16),
  parseInt(hexBg.slice(4, 6), 16),
  255,
];

function validateFrame(name, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`frame "${name}": no rows`);
  }
  const w = rows[0].length;
  rows.forEach((row, y) => {
    if (typeof row !== "string") throw new Error(`frame "${name}" row ${y}: not a string`);
    if (row.length !== w) {
      throw new Error(`frame "${name}" row ${y}: width ${row.length} != ${w} (all rows must match)`);
    }
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch !== "." && !(ch in PALETTE)) {
        throw new Error(`frame "${name}" row ${y} col ${x}: unknown palette key '${ch}'`);
      }
    }
  });
  const h = rows.length;
  const expected = EXPECTED_DIMS[name];
  if (expected && (expected[0] !== w || expected[1] !== h)) {
    throw new Error(`frame "${name}": dims ${w}x${h} != expected ${expected[0]}x${expected[1]}`);
  }
  return { w, h };
}

/** Render a rows[] frame into a transparent RGBA canvas (base palette). */
function renderFrame(rows) {
  return renderFrameTinted(rows, null, null);
}

/**
 * Render a frame, optionally applying a variant tint. `keepGreenRows` (a Set of
 * row indices) holds l/g green even under a tint — used for a carried leaf so a
 * teal/amber/dusk worker still hauls a green leaf.
 *
 * Leaf cells (l/g) swap to `tint.l`/`tint.g`. If the tint carries a `recolor`
 * map (onyx = full-figure charcoal shadow), every OTHER body key is remapped
 * through it; any body key missing from that map throws in `assertRecolorCovers`
 * before we get here, so a full-recolor variant can never leak a base pixel.
 */
function renderFrameTinted(rows, tint, keepGreenRows) {
  const w = rows[0].length;
  const h = rows.length;
  const cv = makeCanvas(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x];
      if (ch === ".") continue;
      let rgba = PALETTE[ch];
      if (tint) {
        const isLeaf = ch === "l" || ch === "g";
        const heldGreen = isLeaf && keepGreenRows && keepGreenRows.has(y);
        if (isLeaf && !heldGreen) {
          rgba = ch === "l" ? tint.l : tint.g;
        } else if (!isLeaf && tint.recolor && ch in tint.recolor) {
          rgba = tint.recolor[ch];
        }
      }
      setPx(cv, x, y, rgba);
    }
  }
  return cv;
}

/**
 * Fail loudly if a `recolor` variant leaves any body key unmapped — a shadow
 * worker with an unremapped warm pixel is a bug we want to catch at generation,
 * not ship. Only checks keys that actually appear in the body frames.
 */
function assertRecolorCovers(bodyFrameNames, frames, variantTints) {
  const bodyKeys = new Set();
  for (const bn of bodyFrameNames) {
    for (const row of frames[bn]) {
      for (const ch of row) {
        if (ch !== "." && ch !== "l" && ch !== "g") bodyKeys.add(ch);
      }
    }
  }
  for (const [variant, tint] of Object.entries(variantTints)) {
    if (!tint || !tint.recolor) continue;
    const missing = [...bodyKeys].filter((ch) => !(ch in tint.recolor));
    if (missing.length) {
      throw new Error(`variant "${variant}" recolor map is missing body keys: ${missing.join(", ")}`);
    }
  }
}

/** Rows forming the top contiguous l/g band of a carry pose (the carried leaf). */
function carriedLeafRows(rows) {
  const hasLeaf = (r) => r.includes("l") || r.includes("g");
  const set = new Set();
  let started = false;
  for (let y = 0; y < rows.length; y++) {
    if (hasLeaf(rows[y])) {
      started = true;
      set.add(y);
    } else if (started) {
      break; // first gap below the overhead leaf — the chest clover lies past it
    }
  }
  return set;
}

function buffersEqual(a, b) {
  return a.length === b.length && a.equals(b);
}

// ---------------------------------------------------------------------------
// Shelf packing
// ---------------------------------------------------------------------------

function packAtlas(items) {
  const PAD = 1;
  const MAX_W = 256;
  const sorted = [...items].sort((a, b) => b.h - a.h || b.w - a.w);
  const place = {};
  let x = PAD;
  let y = PAD;
  let shelfH = 0;
  let usedW = 0;
  let usedH = 0;
  for (const it of sorted) {
    if (x + it.w + PAD > MAX_W) {
      x = PAD;
      y += shelfH + PAD;
      shelfH = 0;
    }
    place[it.name] = { x, y, w: it.w, h: it.h };
    x += it.w + PAD;
    if (it.h > shelfH) shelfH = it.h;
    if (x > usedW) usedW = x;
    if (y + it.h > usedH) usedH = y + it.h;
  }
  return { place, width: usedW + PAD, height: usedH + PAD };
}

// ---------------------------------------------------------------------------
// 3x5 pixel font (labels on the contact sheet)
// ---------------------------------------------------------------------------

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
  return cx - x; // advance width
}

function textWidth(text, scale) {
  return text.length * 4 * scale;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function main() {
  // Contract sanity: FRAME_ORDER must exactly cover FRAMES.
  const frameKeys = Object.keys(FRAMES);
  const missing = FRAME_ORDER.filter((n) => !(n in FRAMES));
  const extra = frameKeys.filter((n) => !FRAME_ORDER.includes(n));
  if (missing.length) throw new Error(`FRAME_ORDER lists names not in FRAMES: ${missing.join(", ")}`);
  if (extra.length) throw new Error(`FRAMES has names not in FRAME_ORDER: ${extra.join(", ")}`);

  // Body-frame + accessory-variant coverage checks.
  const bodyMissing = BODY_FRAME_NAMES.filter((n) => !(n in FRAMES));
  if (bodyMissing.length) throw new Error(`BODY_FRAME_NAMES not in FRAMES: ${bodyMissing.join(", ")}`);
  const variantMissing = VARIANTS.filter((v) => !(v in VARIANT_TINTS) || !(v in ACCESSORIES));
  if (variantMissing.length) throw new Error(`variants missing tint/accessory: ${variantMissing.join(", ")}`);
  assertRecolorCovers(BODY_FRAME_NAMES, FRAMES, VARIANT_TINTS);

  // Validate + render every base frame (green).
  const rendered = {};
  const dims = {};
  for (const name of FRAME_ORDER) {
    const rows = FRAMES[name];
    dims[name] = validateFrame(name, rows);
    rendered[name] = renderFrame(rows);
  }

  // Animations must only reference known frames.
  for (const [anim, def] of Object.entries(ANIMATIONS)) {
    for (const f of def.frames) {
      if (!(f in FRAMES)) throw new Error(`animation "${anim}" references unknown frame "${f}"`);
    }
  }

  // Pack items: green base frames first, then recolored variant body frames, then
  // accessories. Variant body frames that render identically to green (no tinted
  // pixel — e.g. poof) alias the green rect instead of taking new atlas space.
  const packItems = FRAME_ORDER.map((name) => ({ name, w: dims[name].w, h: dims[name].h }));

  // variantRects[variant][bodyName] = the atlas key its rect comes from.
  const variantRects = { green: {} };
  for (const bn of BODY_FRAME_NAMES) variantRects.green[bn] = bn; // green = base alias

  for (const v of VARIANTS) {
    if (v === "green") continue;
    variantRects[v] = {};
    const tint = VARIANT_TINTS[v];
    for (const bn of BODY_FRAME_NAMES) {
      const rows = FRAMES[bn];
      const keep = CARRY_FRAMES.has(bn) ? carriedLeafRows(rows) : null;
      const cv = renderFrameTinted(rows, tint, keep);
      if (buffersEqual(cv.buf, rendered[bn].buf)) {
        variantRects[v][bn] = bn; // no tinted pixels — reuse green
        continue;
      }
      const key = `${v}:${bn}`;
      rendered[key] = cv;
      dims[key] = dims[bn];
      variantRects[v][bn] = key;
      packItems.push({ name: key, w: dims[bn].w, h: dims[bn].h });
    }
  }

  // Accessories (variants with a grid; null means no worn item — skip).
  for (const v of VARIANTS) {
    const key = `acc:${v}`;
    const acc = ACCESSORIES[v];
    if (!acc) continue;
    dims[key] = validateFrame(key, acc);
    rendered[key] = renderFrame(acc);
    packItems.push({ name: key, w: dims[key].w, h: dims[key].h });
  }

  const { place, width: atlasW, height: atlasH } = packAtlas(packItems);
  const atlas = makeCanvas(atlasW, atlasH); // transparent
  for (const it of packItems) {
    blit(atlas, rendered[it.name], place[it.name].x, place[it.name].y);
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(ATLAS_PNG, encodePNG(atlas.width, atlas.height, atlas.buf));

  // Emit atlas.gen.ts.
  fs.writeFileSync(ATLAS_TS, emitTs({ atlasW, atlasH, place, variantRects }));

  // Contact sheet.
  const contact = buildContactSheet(rendered, dims, variantRects);
  fs.writeFileSync(CONTACT_PNG, encodePNG(contact.width, contact.height, contact.buf));

  // Report.
  const variantFrameCount = packItems.length - FRAME_ORDER.length;
  console.log(
    `atlas    : ${path.relative(REPO_DIR, ATLAS_PNG)}  ${atlasW}x${atlasH}, ${packItems.length} rects (${FRAME_ORDER.length} base + ${variantFrameCount} variant/accessory)`,
  );
  console.log(`metadata : ${path.relative(REPO_DIR, ATLAS_TS)}`);
  console.log(`contact  : ${path.relative(REPO_DIR, CONTACT_PNG)}  ${contact.width}x${contact.height}`);
  console.log(`variants : ${VARIANTS.join(", ")}`);
  console.log("\nframe dimensions:");
  for (const name of FRAME_ORDER) {
    const p = place[name];
    console.log(
      `  ${name.padEnd(11)} ${String(dims[name].w).padStart(2)}x${String(dims[name].h).padStart(2)}  @ (${p.x},${p.y})`,
    );
  }
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function unionLines(names, indent = "  ") {
  return chunk(names, 5)
    .map((g) => `${indent}| ${g.map((n) => `'${n}'`).join(" | ")}`)
    .join("\n");
}

function rectLiteral(p) {
  return `{ x: ${p.x}, y: ${p.y}, w: ${p.w}, h: ${p.h} }`;
}

function emitTs({ atlasW, atlasH, place, variantRects }) {
  const frameUnion = unionLines(FRAME_ORDER);
  const frameLines = FRAME_ORDER.map((name) => `  ${name}: ${rectLiteral(place[name])},`).join("\n");

  const variantUnion = VARIANTS.map((v) => `'${v}'`).join(" | ");
  const bodyUnion = unionLines(BODY_FRAME_NAMES);

  const variantBodyBlocks = VARIANTS.map((v) => {
    const lines = BODY_FRAME_NAMES.map((bn) => `    ${bn}: ${rectLiteral(place[variantRects[v][bn]])},`).join(
      "\n",
    );
    return `  ${v}: {\n${lines}\n  },`;
  }).join("\n");

  const accessoryLines = VARIANTS.map((v) =>
    place[`acc:${v}`] === undefined ? `  ${v}: null,` : `  ${v}: ${rectLiteral(place[`acc:${v}`])},`,
  ).join("\n");

  const animNames = Object.keys(ANIMATIONS);
  const animUnion = animNames.map((n) => `'${n}'`).join(" | ");
  const animLines = Object.entries(ANIMATIONS)
    .map(
      ([name, def]) =>
        `  ${name}: { frames: [${def.frames.map((f) => `'${f}'`).join(", ")}], fps: ${def.fps} },`,
    )
    .join("\n");

  const biomeSetLines = BIOME_SETS.map((s) => {
    const tiles = s.tiles.map((t) => `'${t}'`).join(", ");
    const anchors = s.anchors.map((a) => `'${a}'`).join(", ");
    return `  ${s.name}: { tiles: [${tiles}], anchors: [${anchors}] },`;
  }).join("\n");

  const paletteLines = Object.entries(PALETTE)
    .map(([key, rgba]) => `  ${JSON.stringify(key)}: [${rgba.join(", ")}],`)
    .join("\n");
  const variantTintData = JSON.stringify(VARIANT_TINTS, null, 2);

  return `// GENERATED by scripts/garden-sprites/generate.mjs — do not edit
// Source grids: scripts/garden-sprites/{frames,lifecycle}.mjs · palette: scripts/garden-sprites/palette.mjs
// Atlas image: assets/garden-atlas/leafguy-atlas.png

export const ATLAS_SIZE = { width: ${atlasW}, height: ${atlasH} } as const;

// prettier-ignore
export type GardenFrameName =
${frameUnion};

export interface AtlasFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

// prettier-ignore
export const ATLAS_FRAMES: Record<GardenFrameName, AtlasFrame> = {
${frameLines}
};

// --- Harness variants (VUH-454) --------------------------------------------
// A worker's harness maps to a leaf tint; body Atlas rects come from
// VARIANT_BODY_FRAMES[worker.variant]. 'green' aliases the base ATLAS_FRAMES, so
// existing consumers keep working. Accessories ride a separate upright overlay
// slot (green has none).
// prettier-ignore
export type GardenVariant = ${variantUnion};

// prettier-ignore
export type GardenBodyFrameName =
${bodyUnion};

// prettier-ignore
export const VARIANT_BODY_FRAMES: Record<GardenVariant, Record<GardenBodyFrameName, AtlasFrame>> = {
${variantBodyBlocks}
};

// prettier-ignore
export const ACCESSORY_FRAMES: Record<GardenVariant, AtlasFrame | null> = {
${accessoryLines}
};

// Body-local top-left where the accessory overlay sits (head upper-left rim,
// beside the sprout). Single source of truth for the renderer + contact sheet.
// prettier-ignore
export const ACCESSORY_ANCHOR = { x: ${ACCESSORY_ANCHOR.x}, y: ${ACCESSORY_ANCHOR.y} } as const;

// prettier-ignore
export type GardenAnimationName = ${animUnion};

// prettier-ignore
export const ANIMATIONS: Record<GardenAnimationName, { frames: GardenFrameName[]; fps: number }> = {
${animLines}
};

// --- Biome ground-decoration tile sets (VUH-494) ---------------------------
// Grouped handles for VUH-495 to scatter decoration by biome. Every listed name
// is a GardenFrameName with a rect in ATLAS_FRAMES; these are props (never
// variant-tinted). \`anchors\` are the larger centerpiece tiles (a tidepool, a
// grassy patch); \`tiles\` are the small scatterable decorations.
// prettier-ignore
export const BIOME_TILE_SETS = {
${biomeSetLines}
} as const;

export type GardenBiomeName = keyof typeof BIOME_TILE_SETS;

// --- Skill totems (VUH-621 / VUH-518) + lead badge (VUH-538) ----------------
// Real frozen art retiring the procedural placeholders. \`totem\` is one carved
// silhouette; a per-skill glyph from SKILL_GLYPH_FRAMES overlays its cream face at
// TOTEM_GLYPH_ANCHOR (body-local). GardenCanvas picks the glyph per skill by seed
// — floor(seed * SKILL_GLYPH_FRAMES.length) — the same deterministic seed path
// totemAccent() uses, so the art is frozen while the mapping stays data-driven.
// \`leadCrown\` is the gold circlet a per-run lead wears at LEAD_CROWN_ANCHOR.
// prettier-ignore
export const TOTEM_GLYPH_ANCHOR = { x: ${TOTEM_GLYPH_ANCHOR.x}, y: ${TOTEM_GLYPH_ANCHOR.y} } as const;
// prettier-ignore
export const LEAD_CROWN_ANCHOR = { x: ${LEAD_CROWN_ANCHOR.x}, y: ${LEAD_CROWN_ANCHOR.y} } as const;

// Ordered skill-glyph vocabulary (index by seed). Every name is a GardenFrameName
// with a rect in ATLAS_FRAMES.
// prettier-ignore
export const SKILL_GLYPH_FRAMES = [${SKILL_GLYPH_ORDER.map((n) => `'${n}'`).join(", ")}] as const;

export type GardenSkillGlyphName = (typeof SKILL_GLYPH_FRAMES)[number];

// Palette and variant recolors remain pack data so the future SkinPack contract
// can consume the generated manifest without importing the authoring scripts.
export type GardenRgba = readonly [number, number, number, number];

// prettier-ignore
export const PALETTE = {
${paletteLines}
} as const satisfies Record<string, GardenRgba>;

// prettier-ignore
export const VARIANT_TINTS = ${variantTintData} as const;

// prettier-ignore
export const GARDEN_BACKGROUND = '${GARDEN_BACKGROUND}';
`;
}

// ---------------------------------------------------------------------------
// Contact sheet: main frame grid + a variant/accessory comparison band.
// ---------------------------------------------------------------------------

function blitScaled(sheet, src, ox, oy, scale) {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const si = (y * src.width + x) * 4;
      if (src.buf[si + 3] === 0) continue;
      fillRect(sheet, ox + x * scale, oy + y * scale, scale, scale, [
        src.buf[si],
        src.buf[si + 1],
        src.buf[si + 2],
        255,
      ]);
    }
  }
}

function buildContactSheet(rendered, dims, variantRects) {
  const SCALE = 6;
  const LABEL_SCALE = 2;
  const PAD = 10;
  const LABEL_H = 5 * LABEL_SCALE + 6;
  const cream = PALETTE.f;

  const maxW = Math.max(...FRAME_ORDER.map((n) => dims[n].w)) * SCALE;
  const maxH = Math.max(...FRAME_ORDER.map((n) => dims[n].h)) * SCALE;
  const cellW = maxW + PAD * 2;
  const cellH = maxH + LABEL_H + PAD * 2;
  const cols = 5;
  const rows = Math.ceil(FRAME_ORDER.length / cols);

  // Variant band: idle + wilt for every variant, then any accessories.
  const bandRows = 3;
  const bandH = bandRows * cellH + PAD;

  const sheet = makeCanvas(cols * cellW, rows * cellH + bandH, SLATE);

  const drawCell = (col, rowIdx, src, w, h, label) => {
    const cx = col * cellW;
    const cy = rowIdx * cellH;
    const ox = cx + PAD + Math.floor((maxW - w * SCALE) / 2);
    const oy = cy + PAD + (maxH - h * SCALE);
    blitScaled(sheet, src, ox, oy, SCALE);
    const lw = textWidth(label, LABEL_SCALE);
    drawText(sheet, cx + Math.floor((cellW - lw) / 2), cy + PAD + maxH + 4, label, LABEL_SCALE, cream);
    return { cx, cy, ox, oy };
  };

  // Main grid: every frame, green.
  FRAME_ORDER.forEach((name, idx) => {
    drawCell(
      idx % cols,
      Math.floor(idx / cols),
      rendered[name],
      dims[name].w,
      dims[name].h,
      name.toUpperCase(),
    );
  });

  // Variant band, offset below the main grid.
  const bandTop = rows * cellH + PAD;
  const variantRender = (v, bn) => rendered[variantRects[v][bn]];
  const bandCell = (col, bandRowIdx, src, w, h, label, accV) => {
    const cx = col * cellW;
    const cy = bandTop + bandRowIdx * cellH;
    const ox = cx + PAD + Math.floor((maxW - w * SCALE) / 2);
    const oy = cy + PAD + (maxH - h * SCALE);
    blitScaled(sheet, src, ox, oy, SCALE);
    // Composite the accessory on the head rim (recommended anchor, upright).
    if (accV && ACCESSORIES[accV]) {
      const acc = rendered[`acc:${accV}`];
      blitScaled(sheet, acc, ox + ACCESSORY_ANCHOR.x * SCALE, oy + ACCESSORY_ANCHOR.y * SCALE, SCALE);
    }
    const lw = textWidth(label, LABEL_SCALE);
    drawText(sheet, cx + Math.floor((cellW - lw) / 2), cy + PAD + maxH + 4, label, LABEL_SCALE, cream);
  };

  VARIANTS.forEach((v, i) => {
    bandCell(i, 0, variantRender(v, "idle0"), dims.idle0.w, dims.idle0.h, `${v} IDLE`.toUpperCase(), v);
    bandCell(i, 1, variantRender(v, "wilt0"), dims.wilt0.w, dims.wilt0.h, `${v} WILT`.toUpperCase(), null);
  });
  // Third band row: any accessories alone, larger, for art review.
  VARIANTS.filter((v) => rendered[`acc:${v}`] !== undefined).forEach((v, i) => {
    const src = rendered[`acc:${v}`];
    const cx = i * cellW;
    const cy = bandTop + 2 * cellH;
    const ox = cx + PAD + Math.floor((maxW - src.width * SCALE) / 2);
    const oy = cy + PAD + (maxH - src.height * SCALE);
    blitScaled(sheet, src, ox, oy, SCALE);
    const label = `${v} ACC`.toUpperCase();
    const lw = textWidth(label, LABEL_SCALE);
    drawText(sheet, cx + Math.floor((cellW - lw) / 2), cy + PAD + maxH + 4, label, LABEL_SCALE, cream);
  });

  return sheet;
}

// Body-local top-left for the accessory overlay (worn on the crown's left,
// the sprout poking out past it — head top sits at row 8 in the current base
// geometry, so a 6-row accessory here overlaps the rim from row 8 down: worn,
// not perched; a rim-corner perch reads as a droplet). Emitted into
// atlas.gen.ts as ACCESSORY_ANCHOR; the renderer (GardenCanvas) and the
// contact sheet both consume that single value.
const ACCESSORY_ANCHOR = { x: 3, y: 7 };

main();
