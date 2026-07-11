// Garden phase-2 sprite source — lifecycle poses + per-variant accessories,
// layered on top of the base "leaf guy" in frames.mjs (VUH-454 + VUH-469 art).
//
// Kept in its own module (not frames.mjs) on purpose: the base character grids
// are hand-tuned/polished independently, so the phase-2 additions live here and
// generate.mjs merges the two. Same authoring model as frames.mjs — equal-width
// pixel-grid strings keyed to PALETTE, validated loudly by the generator.
//
// What the generator does with these:
//   • wilt0/wilt1 are BODY frames → recolored per harness variant (l/g swap).
//   • seed*/germinate*/seedSink* are props → rendered green, never recolored.
//   • ACCESSORIES ride a per-variant overlay slot (green has none).
//
// The character-derived frames here (wilt, germinate2) are authored against the
// base's 24x28 / rows-0-7-sprout / 8-19-head footprint (see the geometry
// contract in frames.mjs). If the base is re-proportioned, re-sync these — the
// recolor + prop frames are unaffected.

const W = 24; // character canvas width
const H = 28; // character canvas height

// --- shared row/canvas helpers (self-contained; mirrors frames.mjs) --------

function seg(parts, width = W) {
  let s = "";
  for (const [c, n] of parts) s += c.repeat(n);
  if (s.length !== width) {
    throw new Error(`seg width ${s.length} != ${width}: ${JSON.stringify(parts)}`);
  }
  return s;
}
const dots = (n) => [".", n];
const blankRow = (width = W) => ".".repeat(width);

/** Shift a row right by n pixels (pad left with dots, drop the trailing n). */
function shiftRight(row, n = 1) {
  return (".".repeat(n) + row).slice(0, row.length);
}

function canvas(w, h) {
  return Array.from({ length: h }, () => Array(w).fill("."));
}
function toRows(c) {
  return c.map((r) => r.join(""));
}
function rect(c, x0, y0, x1, y1, ch) {
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) if (y >= 0 && y < c.length && x >= 0 && x < c[0].length) c[y][x] = ch;
}
function ellipse(c, cx, cy, rx, ry, ch) {
  for (let y = 0; y < c.length; y++)
    for (let x = 0; x < c[0].length; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) c[y][x] = ch;
    }
}

// --- base head/torso rows (local copies for the character-derived poses) ---
// Must match the frames.mjs geometry contract (rows 8-19 head, 20-27 body).

const FACE_PLAIN = seg([
  dots(3),
  ["o", 1],
  ["f", 1],
  ["m", 1],
  ["f", 12],
  ["m", 1],
  ["f", 1],
  ["o", 1],
  dots(3),
]);
const FACE_EYES = seg([
  dots(3),
  ["o", 1],
  ["f", 1],
  ["m", 1],
  ["f", 2],
  ["e", 2],
  ["f", 4],
  ["e", 2],
  ["f", 2],
  ["m", 1],
  ["f", 1],
  ["o", 1],
  dots(3),
]);
const FACE_CHEEKS = seg([
  dots(3),
  ["o", 1],
  ["f", 1],
  ["m", 1],
  ["f", 1],
  ["p", 2],
  ["f", 6],
  ["p", 2],
  ["f", 1],
  ["m", 1],
  ["f", 1],
  ["o", 1],
  dots(3),
]);
const FACE_BORDER = seg([dots(3), ["o", 1], ["f", 1], ["m", 14], ["f", 1], ["o", 1], dots(3)]);
const HEAD_CAP = seg([dots(5), ["o", 14], dots(5)]);
const HEAD_CAP_STEM = seg([dots(5), ["o", 6], ["s", 2], ["o", 6], dots(5)]);
const HEAD_FRAME_TOP = seg([dots(4), ["o", 1], ["f", 14], ["o", 1], dots(4)]);
const HEAD_FRAME_WIDE = seg([dots(3), ["o", 1], ["f", 16], ["o", 1], dots(3)]);
const HEAD_FRAME_SHADE = seg([dots(4), ["o", 1], ["f", 2], ["d", 10], ["f", 2], ["o", 1], dots(4)]);
const TORSO_TOP = seg([dots(8), ["o", 8], dots(8)]);
const TORSO_CLOVER_TOP = seg([dots(7), ["o", 1], ["k", 3], ["l", 2], ["k", 3], ["o", 1], dots(7)]);
const ARMS_CLOVER_MID = seg([
  dots(5),
  ["o", 1],
  ["k", 1],
  ["o", 1],
  ["k", 2],
  ["l", 1],
  ["g", 2],
  ["l", 1],
  ["k", 2],
  ["o", 1],
  ["k", 1],
  ["o", 1],
  dots(5),
]);
const ARMS_CLOVER_BOT = seg([
  dots(5),
  ["o", 1],
  ["k", 1],
  ["o", 1],
  ["k", 3],
  ["l", 2],
  ["k", 3],
  ["o", 1],
  ["k", 1],
  ["o", 1],
  dots(5),
]);
const ARMS_UNDER = seg([dots(5), ["o", 2], ["K", 10], ["o", 2], dots(5)]);
const LEGS = seg([dots(7), ["o", 1], ["k", 2], ["o", 1], dots(2), ["o", 1], ["k", 2], ["o", 1], dots(7)]);
const FEET = seg([dots(7), ["o", 1], ["K", 2], ["o", 1], dots(2), ["o", 1], ["K", 2], ["o", 1], dots(7)]);
const SOLES = seg([dots(7), ["o", 4], dots(2), ["o", 4], dots(7)]);

// Upright sprout rows 0-7 (matches the base idle sprout).
const SPROUT_UP = [
  seg([dots(14), ["l", 7], dots(3)]), // 0 right leaf tip
  seg([dots(2), ["l", 6], dots(4), ["g", 1], ["l", 8], ["g", 1], dots(2)]), // 1 left leaf top + right leaf
  seg([dots(1), ["l", 7], ["g", 1], dots(2), ["s", 1], ["g", 1], ["l", 9], ["g", 1], dots(1)]), // 2 leaves + stem tip
  seg([dots(1), ["g", 1], ["l", 5], ["g", 3], ["m", 1], ["s", 1], ["g", 8], dots(4)]), // 3 undersides bridge into the fork
  seg([dots(2), ["g", 3], dots(5), ["m", 1], ["s", 2], ["g", 2], dots(9)]), // 4 leaf bases + fork joint
  seg([dots(10), ["m", 1], ["s", 2], dots(11)]), // 5 stem
  seg([dots(10), ["m", 1], ["s", 2], dots(11)]), // 6 stem
  seg([dots(9), ["s", 1], ["m", 2], ["s", 1], dots(11)]), // 7 stem base flare
];

// --- wilt: drooped sprout + tilted head (BODY frame, per variant) ----------
// Deliberately NOT read as sleep: sleep is upright with eyes shut and the sprout
// still perked; wilt flops the big leaves DOWNWARD (vertical-mirror of the up
// sprout so the foliage sags onto the head), leans the head 1px (a slumped
// tilt), and half-lids the eyes. Chest clover + drooped leaves tint per variant;
// wilt1 sinks the whole guy 1px for a slow 2-frame sag.
const SPROUT_DROOP = SPROUT_UP.slice()
  .reverse()
  .map((r) => shiftRight(r, 1));

const wilt0 = [
  ...SPROUT_DROOP, // 0-7 leaves sagging down onto the head
  shiftRight(HEAD_CAP, 1), // 8  head tilted 1px (no upright stem notch)
  shiftRight(HEAD_FRAME_TOP, 1), // 9
  shiftRight(HEAD_FRAME_WIDE, 1), // 10
  shiftRight(FACE_BORDER, 1), // 11
  shiftRight(FACE_PLAIN, 1), // 12
  shiftRight(FACE_PLAIN, 1), // 13
  shiftRight(FACE_PLAIN, 1), // 14 half-lid (upper eye row clear)
  shiftRight(FACE_EYES, 1), // 15 low downcast eyes
  shiftRight(FACE_CHEEKS, 1), // 16
  shiftRight(FACE_BORDER, 1), // 17
  shiftRight(HEAD_FRAME_SHADE, 1), // 18
  shiftRight(HEAD_CAP, 1), // 19
  TORSO_TOP, // 20 body stays centered → the tilt reads at the neck
  TORSO_CLOVER_TOP, // 21
  ARMS_CLOVER_MID, // 22
  ARMS_CLOVER_BOT, // 23
  ARMS_UNDER, // 24
  LEGS, // 25
  FEET, // 26
  SOLES, // 27
];
// wilt1: sink 1px (top blank, feet replanted) — the guy sags a little further.
const wilt1 = [blankRow()].concat(wilt0.slice(0, 24)).concat([LEGS, FEET, SOLES]);

// --- seed: half-buried casing in a soil bump, with an idle glint (12x12) ----
function buildSeed(glint) {
  const c = canvas(12, 12);
  // Seed casing (drawn first; the mound then buries its lower half).
  ellipse(c, 6, 6, 2, 3, "o"); // outline oval
  ellipse(c, 6, 6, 1, 2, "k"); // casing body
  c[7][6] = "K"; // casing shade
  c[5][6] = "o"; // seam notch at the tip
  // Soil bump over the lower half → reads "planted, not yet alive".
  ellipse(c, 6, 10, 6, 3, "E"); // dark rim
  ellipse(c, 6, 9, 6, 2, "D"); // dirt
  ellipse(c, 6, 11, 5, 2, "E"); // grounding foot
  // Idle twinkle on the exposed casing (moves between the two frames).
  if (glint) {
    c[3][6] = "w";
    c[4][5] = "f";
  } else {
    c[4][6] = "f";
  }
  return toRows(c);
}

// --- seedSink: a dormant seed sinking away (reuses poof timing) (12x12) -----
function buildSeedSink(kind) {
  const c = canvas(12, 12);
  if (kind === 0) {
    // Casing mostly gone — just the crown peeks over a raised mound + kicked dust.
    ellipse(c, 6, 5, 2, 2, "o");
    ellipse(c, 6, 5, 1, 1, "k");
    ellipse(c, 6, 9, 6, 3, "E");
    ellipse(c, 6, 8, 6, 3, "D");
    c[4][2] = "w";
    c[3][9] = "w";
  } else {
    // Seed gone — settled soil with a dimple where it sank + faint fading dust.
    ellipse(c, 6, 10, 6, 3, "E");
    ellipse(c, 6, 9, 6, 2, "D");
    c[7][6] = "E";
    c[8][6] = "E";
    c[6][2] = "W";
    c[5][9] = "W";
  }
  return toRows(c);
}

// --- germinate: crack → shoot → emerging leaf guy (24x28, 3f burst) ---------
/** An 8-row soil mound strip (rows 20-27 of the emerging frame). */
function moundStrip() {
  const m = canvas(W, 8);
  ellipse(m, 12, 6, 11, 4, "E");
  ellipse(m, 12, 5, 10, 3, "D");
  ellipse(m, 12, 8, 9, 3, "E");
  return toRows(m);
}
/** A ground mound at the base of a full 24x28 canvas. */
function groundBase(c) {
  ellipse(c, 12, 27, 11, 4, "E");
  ellipse(c, 12, 26, 10, 3, "D");
  ellipse(c, 12, 28, 9, 3, "E");
}
function buildGerminate(stage) {
  if (stage === 2) {
    // Leaf guy emerging: full sprout + head risen out of a fresh mound, buried
    // to the chin (sprout rows 0-7 + head rows 8-19 fill the frame exactly).
    return [
      ...SPROUT_UP, // 0-7
      HEAD_CAP_STEM, // 8
      HEAD_FRAME_TOP, // 9
      HEAD_FRAME_WIDE, // 10
      FACE_BORDER, // 11
      FACE_PLAIN, // 12
      FACE_PLAIN, // 13
      FACE_EYES, // 14
      FACE_EYES, // 15
      FACE_CHEEKS, // 16
      FACE_BORDER, // 17
      HEAD_FRAME_SHADE, // 18
      HEAD_CAP, // 19
      ...moundStrip(), // 20-27 buried body
    ];
  }
  const c = canvas(W, H);
  groundBase(c);
  if (stage === 0) {
    // Crack: a dark split at the mound top with a first green tip.
    rect(c, 11, 22, 12, 25, "E");
    c[22][11] = "o";
    c[23][12] = "o";
    c[21][12] = "l";
    c[20][12] = "l";
    c[21][11] = "g";
  } else {
    // Shoot: a stem with a small forming 2-leaf sprout.
    rect(c, 11, 16, 12, 25, "s");
    ellipse(c, 9, 15, 3, 2, "g");
    ellipse(c, 9, 14, 2, 1, "l");
    ellipse(c, 15, 15, 3, 2, "g");
    ellipse(c, 15, 14, 2, 1, "l");
    c[13][11] = "l";
    c[13][12] = "l";
  }
  return toRows(c);
}

// --- accessories -------------------------------------------------------------
// No per-variant head trinkets: at worker scale, anything on the crown fights
// the sprout for the same few pixels and reads as noise (owner call,
// 2026-07-04) — harness identity is carried by the leaf tint alone. The
// overlay slot, ACCESSORY_ANCHOR, and this map stay wired so a future worn
// item (e.g. the P4.1 avatar's watering can) only has to supply a grid. Any
// new accessory must be wider than tall with its bottom rows sunk into the
// head rim: a tall/narrow shape perched at the rim reads as a droplet.

// --- exports ---------------------------------------------------------------

export const LIFECYCLE_FRAMES = {
  wilt0,
  wilt1,
  seed0: buildSeed(0),
  seed1: buildSeed(1),
  germinate0: buildGerminate(0),
  germinate1: buildGerminate(1),
  germinate2: buildGerminate(2),
  seedSink0: buildSeedSink(0),
  seedSink1: buildSeedSink(1),
};

// Appended after the base frames in the atlas + GardenFrameName union.
export const LIFECYCLE_FRAME_ORDER = [
  "wilt0",
  "wilt1",
  "seed0",
  "seed1",
  "germinate0",
  "germinate1",
  "germinate2",
  "seedSink0",
  "seedSink1",
];

export const LIFECYCLE_ANIMATIONS = {
  seed: { frames: ["seed0", "seed1"], fps: 1 },
  germinate: { frames: ["germinate0", "germinate1", "germinate2"], fps: 6 },
  wilt: { frames: ["wilt0", "wilt1"], fps: 1 },
  seedSink: { frames: ["seedSink0", "seedSink1"], fps: 4 },
};

/** Per-variant accessory sprite; all none today (see note above). Overlay slot, always upright.
 * The gold AVATAR's watering can (VUH-539) is a standalone prop frame (`wateringCan`
 * in frames.mjs), wired via `AVATAR_ACCESSORY_FRAME` — not this per-variant head slot —
 * so gold stays null here too. */
export const ACCESSORIES = {
  green: null,
  teal: null,
  amber: null,
  dusk: null,
  onyx: null,
  azure: null,
  gold: null,
};
