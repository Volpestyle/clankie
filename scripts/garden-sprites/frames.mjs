// Garden sprite frame source — hand-authored pixel grids for the "leaf guy"
// (the app-icon character) and the props around him.
//
// Each frame is an array of equal-length strings; one character per pixel, keyed
// to PALETTE in palette.mjs ('.' = transparent). generate.mjs validates every
// row width + palette key and renders these into the atlas, so a typo here fails
// loudly with a frame name and row number.
//
// Authoring model: a base `idle0` grid is built from run-length row segments,
// then variants are derived with small helpers (clone/splice rows, vertical bob,
// mirror). Big props (stump / jobsite / dust clouds) are drawn procedurally on a
// small canvas. Keep the character on-model with the app icon: big two-leaf
// sprout on a thick forked stem (~1/3 of the character), cream head frame with
// a mid-brown inset border, two dark eyes low on the face, blush at the panel
// bottom, khaki suit with a green chest clover, stubby mitt arms, shaded-khaki
// feet (no dark boots), dark warm-brown outline.
//
// Geometry contract: rows 0-7 sprout · 8-19 head · 20-24 body · 25-27 legs/feet.
// lifecycle.mjs keeps local copies of these rows for its character-derived
// poses (wilt, germinate2) — re-sync it whenever the base geometry changes.

const W = 24; // character canvas width
const H = 28; // character canvas height

// --- row builders ---------------------------------------------------------

/** Build a fixed-width row from [char, count] segments. Throws on miscount. */
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

// --- base character: idle0 ------------------------------------------------

// Head interior rows: o | f | m | 12-col panel | m | f | o.
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

// Body rows. Torso fits cols 7-16 (interior 8-15), with tiny outlined mitt
// nubs at cols 5-7 / 16-18; clover stays centered at cols 10-13.
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
const TORSO_LOWER = seg([dots(7), ["o", 1], ["K", 8], ["o", 1], dots(7)]);
const LEGS = seg([dots(7), ["o", 1], ["k", 2], ["o", 1], dots(2), ["o", 1], ["k", 2], ["o", 1], dots(7)]);
const FEET = seg([dots(7), ["o", 1], ["K", 2], ["o", 1], dots(2), ["o", 1], ["K", 2], ["o", 1], dots(7)]);
const SOLES = seg([dots(7), ["o", 4], dots(2), ["o", 4], dots(7)]);

const idle0 = [
  seg([dots(14), ["l", 7], dots(3)]), // 0 right leaf tip
  seg([dots(2), ["l", 6], dots(4), ["g", 1], ["l", 8], ["g", 1], dots(2)]), // 1 left leaf top + right leaf
  seg([dots(1), ["l", 7], ["g", 1], dots(2), ["s", 1], ["g", 1], ["l", 9], ["g", 1], dots(1)]), // 2 leaves + stem tip
  seg([dots(1), ["g", 1], ["l", 5], ["g", 3], ["m", 1], ["s", 1], ["g", 8], dots(4)]), // 3 undersides bridge into the fork
  seg([dots(2), ["g", 3], dots(5), ["m", 1], ["s", 2], ["g", 2], dots(9)]), // 4 leaf bases + fork joint
  seg([dots(10), ["m", 1], ["s", 2], dots(11)]), // 5 stem
  seg([dots(10), ["m", 1], ["s", 2], dots(11)]), // 6 stem
  seg([dots(9), ["s", 1], ["m", 2], ["s", 1], dots(11)]), // 7 stem base flare
  HEAD_CAP_STEM, // 8 head top (stem enters)
  HEAD_FRAME_TOP, // 9
  HEAD_FRAME_WIDE, // 10
  FACE_BORDER, // 11 inset border top
  FACE_PLAIN, // 12
  FACE_PLAIN, // 13
  FACE_EYES, // 14 eyes (low on the panel)
  FACE_EYES, // 15 eyes
  FACE_CHEEKS, // 16 blush at panel bottom
  FACE_BORDER, // 17 inset border bottom
  HEAD_FRAME_SHADE, // 18
  HEAD_CAP, // 19 head bottom
  TORSO_TOP, // 20
  TORSO_CLOVER_TOP, // 21
  ARMS_CLOVER_MID, // 22
  ARMS_CLOVER_BOT, // 23
  ARMS_UNDER, // 24
  LEGS, // 25
  FEET, // 26
  SOLES, // 27
];

// --- derivation helpers ---------------------------------------------------

/** Copy a grid, replacing rows by index. */
function withRows(grid, overrides) {
  const g = grid.slice();
  for (const [i, row] of Object.entries(overrides)) g[Number(i)] = row;
  return g;
}

/**
 * Vertical "bob up": shift the body (rows 0..H-5) up by one pixel and re-plant
 * the feet, so the character rises 1px while its feet stay on the floor. Used
 * for the passing frames of walk / carry cycles.
 */
function bobUp(grid) {
  const g = [];
  for (let r = 0; r < H - 4; r++) g[r] = grid[r + 1]; // drop row 0, pull everything up
  g[H - 4] = LEGS;
  g[H - 3] = LEGS;
  g[H - 2] = FEET;
  g[H - 1] = SOLES;
  return g;
}

/** Mirror a grid horizontally (each row reversed). */
function mirror(grid) {
  return grid.map((row) => row.split("").reverse().join(""));
}

// --- idle1: blink ---------------------------------------------------------
// Upper eye row opens back to face → the remaining lower row reads as a closed slit.
const idle1 = withRows(idle0, { 14: FACE_PLAIN });

// --- walk cycle -----------------------------------------------------------
// walk0 contact: left foot forward+planted, right foot back+lifted.
// walk2 is the mirror. walk1 / walk3 are the raised passing frames (bob up).
const walk0 = idle0.slice(0, 25).concat([
  seg([dots(6), ["o", 1], ["k", 2], ["o", 1], dots(4), ["o", 1], ["K", 2], ["o", 1], dots(6)]), // 25 L leg fwd, R foot raised
  seg([dots(6), ["o", 1], ["K", 2], ["o", 1], dots(4), ["o", 4], dots(6)]), // 26 L foot, R sole raised
  seg([dots(6), ["o", 4], dots(14)]), // 27 L sole (R foot lifted, empty)
]);
const walk2 = mirror(walk0);
const walk1 = bobUp(idle0);
const walk3 = bobUp(idle0);

// --- work: dig ------------------------------------------------------------
// work0: left arm raised (reaching up beside the head), right arm a down nub,
// body leaning into it.
const work0 = idle0.slice(0, 19).concat([
  seg([dots(3), ["o", 2], ["o", 14], dots(5)]), // 19 hand top beside head cap
  seg([dots(3), ["o", 1], ["k", 1], ["o", 1], dots(2), ["o", 8], dots(8)]), // 20 raised hand + torso top
  seg([dots(3), ["o", 1], ["k", 1], ["o", 1], dots(1), ["k", 3], ["l", 2], ["k", 3], ["o", 1], dots(8)]), // 21 arm joins shoulder + clover top
  seg([
    dots(6),
    ["o", 1],
    ["k", 2],
    ["l", 1],
    ["g", 2],
    ["l", 1],
    ["k", 2],
    ["o", 1],
    ["k", 1],
    ["o", 1],
    dots(6),
  ]), // 22 clover mid + R arm
  seg([dots(6), ["o", 1], ["k", 3], ["l", 2], ["k", 3], ["o", 1], ["k", 1], ["o", 1], dots(6)]), // 23 clover base + R arm
  seg([dots(7), ["o", 1], ["K", 8], ["o", 2], dots(6)]), // 24 lower torso + R arm underline
  LEGS, // 25
  FEET, // 26
  SOLES, // 27
]);
// work1: arms down, body squashed 1px into the ground (impact beat).
const work1 = [blankRow()].concat(idle0.slice(0, 24)).concat([LEGS, FEET, SOLES]);

// --- blocked: both arms up, worried --------------------------------------
const blocked0 = idle0.slice(0, 19).concat([
  seg([dots(3), ["o", 2], ["o", 14], ["o", 2], dots(3)]), // 19 both hand tops beside head cap
  seg([
    dots(3),
    ["o", 1],
    ["k", 1],
    ["o", 1],
    dots(2),
    ["o", 8],
    dots(2),
    ["o", 1],
    ["k", 1],
    ["o", 1],
    dots(3),
  ]), // 20 raised hands + torso top
  seg([
    dots(3),
    ["o", 1],
    ["k", 1],
    ["o", 1],
    dots(1),
    ["k", 4],
    ["l", 2],
    ["k", 4],
    dots(1),
    ["o", 1],
    ["k", 1],
    ["o", 1],
    dots(3),
  ]), // 21 arms join shoulders + clover top
  seg([dots(7), ["o", 1], ["k", 2], ["l", 1], ["g", 2], ["l", 1], ["k", 2], ["o", 1], dots(7)]), // 22 clover mid
  seg([dots(7), ["o", 1], ["k", 3], ["l", 2], ["k", 3], ["o", 1], dots(7)]), // 23 clover base
  TORSO_LOWER, // 24
  LEGS, // 25
  FEET, // 26
  SOLES, // 27
]);

// --- carry: big leaf held overhead ---------------------------------------
// Replace the sprout with a wide leaf + two raised hands. The leaf is the top
// contiguous l/g band (rows 0-3): generate.mjs keeps that band green on the
// per-variant recolors (carriedLeafRows), so it must stay separated from the
// chest clover by leaf-free rows.
const carry0 = [
  seg([dots(7), ["l", 10], dots(7)]), // 0 leaf top
  seg([dots(5), ["g", 1], ["l", 12], ["g", 1], dots(5)]), // 1 leaf body
  seg([dots(6), ["g", 1], ["l", 10], ["g", 1], dots(6)]), // 2 leaf narrowing
  seg([dots(9), ["g", 6], dots(9)]), // 3 leaf underside
  seg([dots(11), ["s", 2], dots(11)]), // 4 leaf stem nub
  blankRow(), // 5
  seg([dots(7), ["o", 1], ["k", 1], ["o", 1], dots(4), ["o", 1], ["k", 1], ["o", 1], dots(7)]), // 6 two raised hands
  seg([dots(7), ["o", 1], ["k", 1], ["o", 1], dots(4), ["o", 1], ["k", 1], ["o", 1], dots(7)]), // 7 hands
  HEAD_CAP, // 8 (no stem — leaf is held above)
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
  TORSO_TOP, // 20
  TORSO_CLOVER_TOP, // 21
  ARMS_CLOVER_MID, // 22
  ARMS_CLOVER_BOT, // 23
  ARMS_UNDER, // 24
  LEGS, // 25
  FEET, // 26
  SOLES, // 27
];
const carry1 = bobUp(carry0);

// --- sleep ----------------------------------------------------------------
// Eyes closed; sleep1 droops the whole guy 1px (nod).
const sleep0 = withRows(idle0, { 14: FACE_PLAIN });
const sleep1 = [blankRow()]
  .concat(withRows(idle0, { 14: FACE_PLAIN }).slice(0, 24))
  .concat([LEGS, FEET, SOLES]);

// --- procedural props: canvas helpers ------------------------------------

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

// --- stump: dirt mound + entrance hole + big sprout (48x40) ----------------
function buildStump() {
  const c = canvas(48, 40);
  // Mound: dark rim, then dirt fill, then a darker foot for grounding.
  ellipse(c, 24, 34, 23, 14, "E");
  ellipse(c, 24, 35, 22, 13, "D");
  ellipse(c, 24, 39, 20, 7, "E");
  ellipse(c, 24, 34, 21, 12, "D"); // re-round the top
  // Entrance hole (dark), with a thin dark rim.
  ellipse(c, 24, 33, 7, 8, "E");
  ellipse(c, 24, 33, 6, 7, "o");
  // Big sprout rising from the mound top.
  rect(c, 23, 8, 24, 22, "s");
  ellipse(c, 14, 8, 8, 5, "g");
  ellipse(c, 14, 7, 6, 4, "l");
  ellipse(c, 34, 8, 8, 5, "g");
  ellipse(c, 34, 7, 6, 4, "l");
  ellipse(c, 24, 4, 4, 3, "g"); // small crown leaf
  ellipse(c, 24, 4, 3, 2, "l");
  return toRows(c);
}

// --- jobsite: dirt patch with pebbles (32x16) -----------------------------
function buildJobsite() {
  const c = canvas(32, 16);
  ellipse(c, 16, 13, 15, 5, "E");
  ellipse(c, 16, 13, 14, 4, "D");
  ellipse(c, 16, 15, 12, 3, "E");
  // Pebbles: gray body + light top.
  const pebble = (x, y) => {
    c[y][x] = "q";
    c[y][x + 1] = "q";
    if (y - 1 >= 0) c[y - 1][x] = "Q";
  };
  pebble(6, 10);
  pebble(12, 9);
  pebble(19, 10);
  pebble(24, 9);
  pebble(9, 12);
  pebble(22, 12);
  return toRows(c);
}

// --- needs-human signpost: wooden board + stake + mound (22x26) ------------
// VUH-559: the approved treatment-B sign art (a hand-painted wooden board on a
// stake in a dirt mound). BARE board — no lettering: the per-item ref (VUH-489,
// EMG-12, …) is dynamic, so the board bakes here and GardenCanvas draws the
// stacked prefix/number (treatment B) on the cream field at render time. Geometry
// mirrors preview-signposts.mjs `postGrid()` so the baked sign matches the
// signed-off preview exactly. Cream field `f`, warm-brown frame/stake `o`/`m`,
// dirt mound `D`. A prop (never variant-tinted).
const SIGN_BOARD_W = 22;
const SIGN_BOARD_H = 15;
const SIGN_POST_H = 9;
const SIGN_MOUND_H = 2;
function buildSignpost() {
  const rows = [];
  // Board: cream field inside a warm-brown frame.
  for (let y = 0; y < SIGN_BOARD_H; y++) {
    if (y === 0 || y === SIGN_BOARD_H - 1) rows.push("o".repeat(SIGN_BOARD_W));
    else rows.push("o" + "f".repeat(SIGN_BOARD_W - 2) + "o");
  }
  // Stake: a mid-brown post (outlined) centered under the board.
  const stakeL = Math.floor((SIGN_BOARD_W - 4) / 2);
  for (let y = 0; y < SIGN_POST_H; y++) {
    let row = "";
    for (let x = 0; x < SIGN_BOARD_W; x++) {
      if (x === stakeL || x === stakeL + 3) row += "o";
      else if (x === stakeL + 1 || x === stakeL + 2) row += "m";
      else row += ".";
    }
    rows.push(row);
  }
  // Dirt mound at the base.
  for (let y = 0; y < SIGN_MOUND_H; y++) {
    const inset = 6 - y * 2;
    let row = "";
    for (let x = 0; x < SIGN_BOARD_W; x++) row += x >= inset && x < SIGN_BOARD_W - inset ? "D" : ".";
    rows.push(row);
  }
  return rows;
}

// --- leaf: carried result item (12x10) ------------------------------------
function buildLeaf() {
  const c = canvas(12, 10);
  ellipse(c, 6, 4, 4, 3, "g");
  ellipse(c, 5, 4, 3, 2, "l");
  rect(c, 5, 2, 6, 7, "s"); // central vein/stem hint
  rect(c, 5, 1, 6, 1, "s"); // tip
  ellipse(c, 6, 4, 4, 3, "g"); // re-outline over the vein edges
  rect(c, 5, 3, 6, 5, "l");
  c[8][5] = "s";
  c[9][5] = "s";
  return toRows(c);
}

// --- watering can: the avatar's identity prop (16x12) ---------------------
// VUH-539: the tap-to-move AVATAR (gold-1 leaf guy) carries a little watering can
// as his identity trinket. Fable's direction: a NEUTRAL tin/pewter body with the
// standard dark outline (a gold can would fight the gold leaf tint and smear the
// silhouette into one blob) and stubby proportions. The silhouette carries THREE
// legible features so it never collapses into a gray ball at garden zoom: a
// diagonal spout rising up-right to a flared rose, a chunky body, and a C-handle
// loop on the left with an open hole (gripped by the avatar's mitt). One bold
// marker-gold band across the body ties the can to its gold-1 owner (matches the
// gold variant's leaf-dark) and stays readable when downscaled. Drawn directly in
// palette keys (tin `n`/`N`, gold `r`, outline `o`, glint `w`) — never variant-
// tinted (it is a prop, absent from BODY_FRAME_NAMES), so it stays pewter on every
// harness ground. Wired via AVATAR_ACCESSORY_FRAME in GardenCanvas.
const wateringCan = [
  "............oo..", // 0  rose tip cap
  "...........ono..", // 1  flared rose head
  "..........ono...", // 2  spout tube (outlined tin core)
  ".........ono....", // 3  spout tube
  "..oo....ono.....", // 4  handle top cap + spout base
  "..oooooonnoo....", // 5  handle arm meets body top + spout opening
  ".o...ownnnno....", // 6  handle outer wall + body (w = 1px tin glint)
  ".o...onnnnNo....", // 7  handle wall + body (N = pewter right shade)
  ".o...orrrrro....", // 8  handle wall + gold marker band
  "..oooonnnNNo....", // 9  handle lower arm + body
  ".....oNNNNNo....", // 10 body bottom shade
  ".....ooooooo....", // 11 body base outline
];

// --- poof: dust-cloud disappearance (24x28) -------------------------------
// Cloud puffs: light 'w' top-left, shade 'W' underneath.
function puff(c, cx, cy, rx, ry) {
  ellipse(c, cx, cy + 1, rx, ry, "W");
  ellipse(c, cx, cy, rx, ry, "w");
}
function buildPoof(kind) {
  const c = canvas(24, 28);
  if (kind === 0) {
    // small, tight cloud near the ground
    puff(c, 12, 19, 5, 4);
    puff(c, 8, 21, 3, 3);
    puff(c, 16, 21, 3, 3);
  } else if (kind === 1) {
    // big, billowing cloud covering the character
    puff(c, 12, 15, 8, 6);
    puff(c, 6, 18, 4, 4);
    puff(c, 18, 18, 4, 4);
    puff(c, 12, 21, 6, 4);
    puff(c, 10, 11, 3, 3);
    puff(c, 15, 11, 3, 3);
  } else {
    // dispersing: scattered, thinning puffs pushed outward
    puff(c, 6, 9, 3, 3);
    puff(c, 18, 11, 3, 2);
    puff(c, 3, 17, 2, 2);
    puff(c, 21, 16, 2, 2);
    puff(c, 12, 7, 2, 2);
    puff(c, 13, 21, 3, 2);
    puff(c, 8, 22, 2, 2);
  }
  return toRows(c);
}

// --- glyphs (8x10): cream body over the slate ----------------------------
const glyphQ = [
  "..yyyy..",
  ".yy..yy.",
  ".....yy.",
  "....yy..",
  "...yy...",
  "...yy...",
  "........",
  "...yy...",
  "...yy...",
  "........",
];
const glyphZ = [
  "........",
  ".yyyyyy.",
  ".....yy.",
  "....yy..",
  "...yy...",
  "..yy....",
  ".yy.....",
  ".yyyyyy.",
  "........",
  "........",
];
const glyphBang = [
  "...yy...",
  "...yy...",
  "...yy...",
  "...yy...",
  "...yy...",
  "...yy...",
  "........",
  "...yy...",
  "...yy...",
  "........",
];
// Ellipsis "…" — awaiting workers. Three flat 2x2 dots, evenly spaced across the
// width and vertically centered, so it reads as three dots (not a bar) at scale.
const glyphDots = [
  "........",
  "........",
  "........",
  "........",
  "yy.yy.yy",
  "yy.yy.yy",
  "........",
  "........",
  "........",
  "........",
];

// --- exports --------------------------------------------------------------

export const FRAMES = {
  idle0,
  idle1,
  walk0,
  walk1,
  walk2,
  walk3,
  work0,
  work1,
  carry0,
  carry1,
  blocked0,
  sleep0,
  sleep1,
  poof0: buildPoof(0),
  poof1: buildPoof(1),
  poof2: buildPoof(2),
  stump: buildStump(),
  jobsite: buildJobsite(),
  leaf: buildLeaf(),
  wateringCan,
  signpost: buildSignpost(),
  glyphQ,
  glyphZ,
  glyphBang,
  glyphDots,
};

// Contract order — must match the GardenFrameName union in atlas.gen.ts.
export const FRAME_ORDER = [
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
  "poof0",
  "poof1",
  "poof2",
  "stump",
  "jobsite",
  "leaf",
  "wateringCan",
  "signpost",
  "glyphQ",
  "glyphZ",
  "glyphBang",
  "glyphDots",
];

export const ANIMATIONS = {
  idle: { frames: ["idle0", "idle0", "idle0", "idle0", "idle0", "idle0", "idle0", "idle1"], fps: 2 },
  walk: { frames: ["walk0", "walk1", "walk2", "walk3"], fps: 6 },
  work: { frames: ["work0", "work1"], fps: 3 },
  carry: { frames: ["carry0", "carry1"], fps: 6 },
  blocked: { frames: ["blocked0"], fps: 1 },
  sleep: { frames: ["sleep0", "sleep1"], fps: 1 },
  poof: { frames: ["poof0", "poof1", "poof2"], fps: 8 },
};
