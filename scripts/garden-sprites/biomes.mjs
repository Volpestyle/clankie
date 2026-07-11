// Garden phase-3 sprite source — biome ground-decoration tiles (VUH-494 art).
//
// A later slice (VUH-495) scatters these across the world map; this module owns
// the ART only. Kept in its own module (like lifecycle.mjs) so the base-character
// grids in frames.mjs stay untouched — generate.mjs merges the three sources.
// Same authoring model: equal-width pixel-grid strings keyed to PALETTE, validated
// loudly by the generator. '.' = transparent (the app composites over the slate).
//
// Aesthetic contract (docs/garden-view.md, VUH-494 brief):
//   • Figure/ground: decoration reads QUIETER than the leaf guys. Ground tiles use
//     the muted earth/water palette; foliage uses the muted olive 'g'/'s', NEVER
//     the actors' bright leaf 'l' — that yellow-green stays unique to the workers.
//   • Territory contrast: a biome tinted like a worker variant (teal Tidepools,
//     amber Sunflower, dusk Fern Hollow) must stay DARKER/quieter than that
//     variant's sprite, so the actor still pops when it stands on its own ground.
//   • Flat colors on slate. No gradients, glow, shadows, or outlines beyond what
//     the existing frames already do. Nearest-neighbor / integer grid.
//
// Each tile is a props frame: rendered green (base palette), never variant-tinted.

// --- shared canvas helpers (self-contained; mirrors frames.mjs / lifecycle.mjs) --

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
/** Bresenham line — used for grass blades / reeds so they lean instead of reading as bars. */
function line(c, x0, y0, x1, y1, ch) {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  for (;;) {
    if (y >= 0 && y < c.length && x >= 0 && x < c[0].length) c[y][x] = ch;
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

// ===========================================================================
// MEADOW — home biome around the stump: grass tufts, small daisies, pebbles.
// Muted olive foliage + gray pebbles + a quiet white daisy. No new colors.
// ===========================================================================

/**
 * A splayed grass tuft. Each blade is [baseX, tipX, tipY]: rooting the blades at
 * spread-out base positions (not one shared point) keeps them thin and separated
 * so the clump reads as grass, not a solid fan/hand.
 */
function grassTuft(w, h, blades) {
  const c = canvas(w, h);
  const by = h - 1;
  for (const [bx, tx, ty] of blades) line(c, bx, by, tx, ty, "g");
  // brown base across the roots so the blades ground instead of floating.
  const roots = blades.map((b) => b[0]);
  for (let x = Math.min(...roots); x <= Math.max(...roots); x++) c[by][x] = "s";
  return toRows(c);
}

// Every blade LEANS (>=2px of horizontal travel) with staggered tip heights and a
// single off-centre tall accent — no dead-vertical blade, no symmetric fan — so
// the silhouette reads as wind-leaned grass, not a cactus/agave.
const meadowTuft = grassTuft(9, 7, [
  [2, 0, 3],
  [3, 1, 0],
  [4, 6, 1],
  [5, 7, 3],
  [6, 8, 4],
]);

const meadowTuftTall = grassTuft(9, 10, [
  [2, 0, 4],
  [3, 1, 1],
  [4, 7, 0],
  [5, 8, 3],
  [6, 8, 6],
]);

/** Tiny 3-leaflet clover clump on a short stem. */
const meadowClover = [".gg.gg.", ".gg.gg.", "..ggg..", "..ggg..", "...s...", "...s..."];

/** Small white daisy: ring of quiet petals, warm-brown center, leafy stem. */
const meadowDaisy = [".W.W.", "WWWWW", ".WmW.", "..s..", ".gsg.", "..s.."];

/** A couple of scattered pebbles (gray body, light top) — matches the jobsite look. */
const meadowPebbles = ["........", "..Q.....", ".qq..Q..", ".qq.qq..", "........"];

// ===========================================================================
// TIDEPOOLS / CREEK — teal water edges, stepping stones, lily pads. Muted teal
// water (c / C) stays darker than the teal worker; stones are the shared gray.
// ===========================================================================

/** A rounded stepping stone: gray body, light top, dark grounded base. */
function buildStone(w, h) {
  const c = canvas(w, h);
  const cx = (w - 1) / 2;
  ellipse(c, cx, h - 3, w / 2 - 0.5, h / 2, "q");
  ellipse(c, cx - 0.5, h - 4, w / 2 - 1.5, 1, "Q");
  // ground the base row in dark earth.
  for (let x = 0; x < w; x++) if (c[h - 1][x] === "q") c[h - 1][x] = "E";
  return toRows(c);
}
const tideStone = buildStone(8, 6);
const tideStoneSm = buildStone(6, 5);

/**
 * A lily pad floating on its own little puddle. Tiles scatter on bare slate (no
 * global water layer), so the pad carries a muted c/C puddle for water context.
 * The pad is olive 'g' with an 's' shaded lower edge (one step muted) so it does
 * not compete with green-variant actors; the notch shows the water behind it.
 */
function buildLily() {
  const c = canvas(11, 8);
  // muted water puddle the pad sits on.
  ellipse(c, 5, 5, 5, 2, "c");
  ellipse(c, 5, 6, 4, 1.2, "C"); // depth toward the bottom
  // pad on the surface (drawn over the water).
  ellipse(c, 5, 3, 3.6, 1.9, "g");
  // pie-slice notch — reveal the water behind the wedge.
  c[3][8] = "c";
  c[3][7] = "c";
  c[4][8] = "c";
  c[2][8] = ".";
  // shaded lower edge + central vein (mutes the pad, adds a little form).
  c[4][3] = "s";
  c[4][4] = "s";
  c[4][5] = "s";
  c[3][5] = "s";
  return toRows(c);
}
const tideLily = buildLily();

/** Water-edge reeds: two leaning olive blades + a slim brown cattail head. */
function buildReed() {
  const c = canvas(6, 10);
  // stems
  line(c, 2, 9, 2, 2, "s");
  line(c, 4, 9, 4, 3, "s");
  // leaning blades
  line(c, 2, 9, 0, 4, "g");
  line(c, 4, 9, 5, 3, "g");
  // cattail head on the taller stem.
  c[1][2] = "b";
  c[2][1] = "b";
  c[2][2] = "m";
  c[3][1] = "b";
  c[3][2] = "b";
  return toRows(c);
}
const tideReed = buildReed();

/** A small water puddle / ripple: muted teal with a deeper ripple line. */
function buildRipple() {
  const c = canvas(10, 5);
  ellipse(c, 4.5, 2, 4.5, 1.6, "c");
  rect(c, 3, 1, 6, 1, "C");
  rect(c, 5, 3, 8, 3, "C");
  return toRows(c);
}
const tideRipple = buildRipple();

/** Anchor: stacked stepping-stone cairn with a muted teal pool ring at its foot. */
function buildTidePool() {
  const c = canvas(18, 12);
  ellipse(c, 9, 10, 7, 1.4, "C");
  ellipse(c, 9, 10, 5.5, 0.8, "c");

  ellipse(c, 9, 8, 5, 1.9, "q");
  ellipse(c, 8, 7, 3.2, 0.9, "Q");
  for (let x = 4; x <= 14; x++) if (c[9][x] === "q") c[9][x] = "E";
  c[8][5] = "E";
  c[8][13] = "E";

  ellipse(c, 8, 5, 3.4, 1.4, "q");
  ellipse(c, 7, 4, 2.1, 0.8, "Q");
  for (let x = 5; x <= 11; x++) if (c[6][x] === "q") c[6][x] = "E";
  c[5][11] = "o";

  ellipse(c, 10, 2, 2.2, 1.1, "q");
  c[1][10] = "Q";
  c[2][9] = "Q";
  c[3][10] = "E";
  c[2][12] = "o";
  return toRows(c);
}
const tidePool = buildTidePool();

// ===========================================================================
// FERN HOLLOW — dusk-tinted moss + ferns (dusk-worker territory). Cool muted
// moss (v / V) reads as dusk shade and stays green (not violet), so the violet
// dusk worker contrasts against it. Foliage still avoids the actors' bright 'l'.
// ===========================================================================

/**
 * A fern frond: an arching rachis with pinnae leaflets that shrink toward the tip.
 * `dense` packs a fuller inner row of leaflets (used by the standalone fernFrond
 * so it reads as a fern, not a palm; the multi-frond pair/clump stay lighter).
 */
function buildFrond(w, h, lean, dense = false) {
  const c = canvas(w, h);
  const bx = Math.floor(w / 2);
  const by = h - 1;
  const mid = Math.floor(h / 2);
  const maxSpan = Math.floor((w - 1) / 2);
  // rachis (curved: lower half straight, upper half leans).
  line(c, bx, by, bx, mid, "s");
  line(c, bx, mid, bx + lean, 0, "s");
  // pinnae: pairs of short leaflets down the rachis, longer + fuller near the base.
  for (let y = 1; y < by; y++) {
    const t = (y - 1) / (by - 1); // 0 at tip .. 1 at base
    const base = dense ? 2 : 1;
    const span = Math.min(maxSpan, Math.max(base, Math.round(base + t * 2)));
    // follow the rachis x as it leans.
    const rx = y < mid ? Math.round(bx + lean * (1 - y / mid)) : bx;
    for (let d = 1; d <= span; d++) {
      const ch = d === span ? "V" : "v"; // dark outer tip, cool-green inner
      if (rx - d >= 0 && c[y][rx - d] === ".") c[y][rx - d] = ch;
      if (rx + d < w && c[y][rx + d] === ".") c[y][rx + d] = ch;
    }
  }
  return toRows(c);
}
const fernFrond = buildFrond(9, 10, 2, true);

/** Two fronds arching apart from a shared base. */
function buildFernPair() {
  const c = canvas(12, 10);
  const stamp = (rows, ox) => {
    for (let y = 0; y < rows.length; y++)
      for (let x = 0; x < rows[y].length; x++)
        if (rows[y][x] !== "." && c[y]?.[ox + x] === ".") c[y][ox + x] = rows[y][x];
  };
  stamp(buildFrond(7, 9, -2), 0);
  stamp(buildFrond(7, 10, 2), 5);
  return toRows(c);
}
const fernPair = buildFernPair();

/** A low moss patch: cool-green dabs with a couple of deep-moss specks. */
function buildFernMoss() {
  const c = canvas(9, 5);
  ellipse(c, 4, 4, 4, 1.4, "v");
  ellipse(c, 4, 4, 4, 1.1, "v");
  c[2][2] = "v";
  c[2][5] = "v";
  c[2][6] = "v";
  c[3][1] = "V";
  c[3][7] = "V";
  c[4][4] = "V";
  return toRows(c);
}
const fernMoss = buildFernMoss();

/** A curled fiddlehead shoot on a mossy base. */
function buildFiddlehead() {
  const c = canvas(6, 8);
  line(c, 2, 7, 2, 3, "s"); // stalk
  // curl at the top
  c[2][2] = "v";
  c[1][2] = "v";
  c[1][3] = "v";
  c[2][4] = "v";
  c[3][4] = "V";
  c[3][3] = "V";
  c[7][1] = "V";
  c[7][2] = "V";
  c[7][3] = "V";
  return toRows(c);
}
const fernShoot = buildFiddlehead();

/** Anchor: mossy standing stone with one fern frond arching over it. */
function buildFernClump() {
  const c = canvas(14, 10);
  const stone = [
    "..............",
    "....ooooo.....",
    "...oqqqqqo....",
    "..oqqqqqqqo...",
    "..oqqqqqqqo...",
    "..oqqqqqqqo...",
    "...oqqqqqo....",
    "...oqqqqqo....",
    "..oqqqqqqqo...",
    ".ooooooooooo..",
  ];
  for (let y = 0; y < stone.length; y++)
    for (let x = 0; x < stone[y].length; x++) if (stone[y][x] !== ".") c[y][x] = stone[y][x];

  // One curved frond enters from the left and hooks over the stone.
  line(c, 0, 5, 2, 3, "s");
  line(c, 2, 3, 5, 0, "s");
  line(c, 5, 0, 9, 0, "s");
  const leaflets = [
    [1, 4, "g"],
    [3, 3, "g"],
    [4, 2, "g"],
    [7, 0, "V"],
  ];
  for (const [x, y, ch] of leaflets) c[y][x] = ch;

  // Moss reads as clustered patches on the upper-left face, not scattered specks.
  c[2][4] = "v";
  c[2][5] = "v";
  c[3][4] = "v";
  c[3][5] = "V";
  c[4][6] = "v";
  c[4][7] = "v";
  c[5][6] = "V";
  c[5][7] = "V";

  for (let y = 0; y < stone.length; y++)
    for (let x = 0; x < stone[y].length; x++) if (stone[y][x] === "o") c[y][x] = "o";
  return toRows(c);
}
const fernClump = buildFernClump();

// ===========================================================================
// SUNFLOWER FIELD — amber stalks + heads (amber-worker territory). Petals use a
// MUTED gold (G / H), held duller + darker than the amber worker so the amber
// sprite still reads on its own field. Stalks/leaves are the muted olive 'g'/'s'.
// ===========================================================================

/**
 * A sunflower bloom: rounded muted-gold petals (no spiky halo — noisy at scale)
 * around a dark disc, on a short stem. Petals are held duller (H shade on the
 * lower half) and the disc is darkened so the bloom stops out-shouting the amber
 * worker.
 */
function buildSunflowerHead() {
  const c = canvas(9, 10);
  ellipse(c, 4, 3, 4, 3, "G"); // petals (rounded ring)
  ellipse(c, 5, 4, 3.4, 2.2, "H"); // lower-right shade → one step duller
  ellipse(c, 4, 3, 2, 1.7, "H"); // disc rim
  ellipse(c, 4, 3, 1.1, 1, "b"); // dark seed centre (darkened)
  line(c, 4, 6, 4, 9, "s"); // stem
  c[7][2] = "g";
  c[8][2] = "g";
  c[7][6] = "g";
  return toRows(c);
}
const sunflowerHead = buildSunflowerHead();

/** A closed bud: green sepals cupping a gold peek, on a leafy stem. */
function buildSunflowerBud() {
  const c = canvas(6, 9);
  ellipse(c, 3, 2, 2, 2, "g");
  c[1][3] = "G";
  c[2][3] = "G";
  c[2][2] = "H";
  line(c, 3, 3, 3, 8, "s"); // stem
  c[5][1] = "g";
  c[5][2] = "g";
  c[6][4] = "g";
  return toRows(c);
}
const sunflowerBud = buildSunflowerBud();

/** A leafy stalk (no bloom) — filler between the flowers. */
function buildSunflowerStalk() {
  const c = canvas(7, 11);
  line(c, 3, 10, 3, 0, "s"); // stem
  // paired leaves at intervals.
  c[3][1] = "g";
  c[3][2] = "g";
  c[4][1] = "g";
  c[5][5] = "g";
  c[5][4] = "g";
  c[6][5] = "g";
  c[7][2] = "g";
  c[8][1] = "g";
  c[8][2] = "g";
  return toRows(c);
}
const sunflowerStalk = buildSunflowerStalk();

/** A young shoot: two seed-leaves on a stub of stem. */
function buildSunflowerSprout() {
  const c = canvas(6, 6);
  line(c, 3, 5, 3, 2, "s");
  c[2][1] = "g";
  c[1][2] = "g";
  c[2][2] = "g";
  c[2][4] = "g";
  c[1][3] = "g";
  c[2][3] = "g";
  return toRows(c);
}
const sunflowerSprout = buildSunflowerSprout();

/** Anchor: leaning sheaf of harvested sunflower stalks with small amber heads. */
function buildSunflowerTall() {
  const c = canvas(18, 13);
  const stalks = [
    [4, 12, 7, 7, 8, 3],
    [6, 12, 8, 7, 10, 2],
    [9, 12, 10, 7, 12, 3],
    [12, 12, 11, 7, 14, 4],
    [14, 12, 12, 7, 15, 5],
  ];
  for (const [bx, by, mx, my, tx, ty] of stalks) {
    line(c, bx, by, mx, my, "s");
    line(c, mx, my, tx, ty, "s");
    line(c, bx + 1, by, mx + 1, my, "m");
    line(c, mx + 1, my, tx + 1, ty, "m");
  }
  c[10][5] = "g";
  c[10][6] = "g";
  c[9][12] = "g";
  c[9][13] = "g";

  const head = (x, y) => {
    c[y - 1][x - 1] = "a";
    c[y - 1][x] = "a";
    c[y - 1][x + 1] = "a";
    c[y][x - 1] = "a";
    c[y][x] = "b";
    c[y][x + 1] = "a";
    c[y + 1][x - 1] = "a";
    c[y + 1][x] = "a";
    c[y + 1][x + 1] = "a";
  };
  head(7, 3);
  head(11, 2);
  head(15, 4);

  line(c, 7, 7, 12, 7, "b");
  c[8][9] = "b";
  c[8][10] = "b";
  c[12][4] = "E";
  c[12][14] = "E";
  return toRows(c);
}
const sunflowerTall = buildSunflowerTall();

// ===========================================================================
// MUSHROOM GROVE — dim caps + spore dots (where idle roamers doze). Kept in the
// quiet earth range (brown caps m/E/b, cream stems k/K, pale spots/spores f/w/W)
// — no new colors; the shapes carry the biome, staying well under the actors.
// ===========================================================================

/** A capped mushroom: rounded brown cap with a shaded underside, pale stem, spots. */
function buildMushroom(w, h) {
  const c = canvas(w, h);
  const cx = Math.floor((w - 1) / 2);
  const capH = Math.max(2, Math.floor(h / 2) - 1);
  ellipse(c, cx, capH - 1, cx + 0.5, capH - 0.5, "m"); // cap dome
  for (let x = 0; x < w; x++) if (c[capH][x] === "m") c[capH][x] = "E"; // shaded underside
  rect(c, cx - 1, capH + 1, cx + 1, h - 1, "k"); // stem
  for (let y = capH + 1; y < h; y++) c[y][cx + 1] = "K"; // stem shade
  c[h - 1][cx - 1] = "K";
  c[1][cx] = "f"; // cap spots
  c[capH - 1][cx + 1] = "f";
  return toRows(c);
}
const mushroomCap = buildMushroom(7, 8);

/** Two mushrooms of different heights sharing a spot. */
function buildMushroomPair() {
  const c = canvas(11, 9);
  const stamp = (rows, ox, oy) => {
    for (let y = 0; y < rows.length; y++)
      for (let x = 0; x < rows[y].length; x++)
        if (
          rows[y][x] !== "." &&
          oy + y >= 0 &&
          oy + y < c.length &&
          ox + x < c[0].length &&
          c[oy + y][ox + x] === "."
        )
          c[oy + y][ox + x] = rows[y][x];
  };
  stamp(buildMushroom(7, 8), 0, 1);
  stamp(buildMushroom(5, 6), 6, 3);
  return toRows(c);
}
const mushroomPair = buildMushroomPair();

/** A tiny button mushroom. */
function buildMushroomTiny() {
  const c = canvas(5, 5);
  ellipse(c, 2, 1, 2, 1.2, "m");
  c[2][1] = "E";
  c[2][2] = "E";
  c[2][3] = "E";
  c[3][2] = "k";
  c[4][2] = "K";
  c[1][2] = "f";
  return toRows(c);
}
const mushroomTiny = buildMushroomTiny();

/** Taller center mushroom for the landmark ring: lighter cap, full dark outline, tight spots. */
function buildMushroomLandmarkTall() {
  return [
    "...ooo...",
    "..ommmmo.",
    ".ommmmmmo",
    ".omfmfmmo",
    "..ooooo..",
    "...kKK...",
    "...kKK...",
    "...kKK...",
    "..KKK....",
    ".........",
  ];
}

/**
 * Spore dots: a moss dab shedding a tight diagonal DRIFT of spores. Dimmed to
 * grey-green (W / Q, no bright single 'w') and clustered in pairs so it reads as
 * spore drift, not stray dead pixels / render artifacts on slate at game scale.
 */
function buildMushroomSpores() {
  const c = canvas(9, 6);
  // moss dab base.
  c[5][2] = "g";
  c[5][3] = "g";
  c[5][4] = "g";
  c[5][5] = "g";
  c[4][3] = "v";
  c[4][4] = "g";
  // spore drift: clustered grey-green pairs rising diagonally, thinning up.
  c[3][3] = "W";
  c[3][4] = "W";
  c[2][4] = "W";
  c[2][5] = "Q";
  c[1][5] = "Q";
  return toRows(c);
}
const mushroomSpores = buildMushroomSpores();

/** Anchor: a ring of small caps around one tall cap. */
function buildMushroomCluster() {
  const c = canvas(18, 12);
  ellipse(c, 9, 11, 8, 1.5, "E");
  ellipse(c, 9, 10, 7, 1, "D");
  const stamp = (rows, ox, oy) => {
    for (let y = 0; y < rows.length; y++)
      for (let x = 0; x < rows[y].length; x++)
        if (rows[y][x] !== "." && oy + y >= 0 && oy + y < c.length && ox + x >= 0 && ox + x < c[0].length)
          c[oy + y][ox + x] = rows[y][x];
  };
  stamp(buildMushroomLandmarkTall(), 5, 1);
  stamp(buildMushroomTiny(), 1, 6);
  stamp(buildMushroomTiny(), 4, 7);
  stamp(buildMushroomTiny(), 12, 7);
  stamp(buildMushroomTiny(), 14, 6);
  stamp(buildMushroomTiny(), 2, 4);
  stamp(buildMushroomTiny(), 13, 4);
  c[10][7] = "g";
  c[10][10] = "g";
  return toRows(c);
}
const mushroomCluster = buildMushroomCluster();

// ===========================================================================
// ROCK GARDEN — sparse stones + raked-line hints (dormant seeds live here).
// Grey stone (q/Q) + dark grooves (E/o). No new colors; kept muted + sparse.
// ===========================================================================

/** A stone/boulder: grey body, light top-left facet, dark grounded base, a crack. */
function buildRock(w, h) {
  const c = canvas(w, h);
  const cx = (w - 1) / 2;
  ellipse(c, cx, h - 2, w / 2 - 0.5, h - 1.5, "q");
  ellipse(c, cx - 0.8, h - 3, w / 2 - 1.8, h / 2 - 0.5, "Q"); // top-left light facet
  for (let x = 0; x < w; x++) if (c[h - 1][x] === "q") c[h - 1][x] = "E"; // grounded base
  if (h >= 6) {
    c[h - 3][Math.round(cx) + 1] = "o"; // a small facet crack
    c[h - 2][Math.round(cx) + 1] = "o";
  }
  return toRows(c);
}
const rockStone = buildRock(9, 7);
const rockStoneSm = buildRock(6, 5);

/** A raked-gravel patch: low grey bed with horizontal rake lines (lit ridge, shadow groove). */
function buildRaked() {
  const c = canvas(14, 5);
  ellipse(c, 7, 2, 7, 1.9, "q"); // gravel bed
  for (let x = 0; x < 14; x++) {
    if (c[1][x] === "q") c[1][x] = "Q"; // raked ridge (catches light)
    if (c[3][x] === "q") c[3][x] = "E"; // raked groove (in shadow)
  }
  return toRows(c);
}
const rockRaked = buildRaked();

/** A small stacked-stone cairn (three balanced stones). */
function buildCairn() {
  const c = canvas(7, 9);
  ellipse(c, 3, 7, 3, 1.5, "q"); // base stone
  ellipse(c, 3, 4, 2.2, 1.3, "q"); // middle stone
  ellipse(c, 3, 2, 1.4, 1, "Q"); // top stone (small, lit)
  c[7][2] = "Q";
  c[8][2] = "E";
  c[8][3] = "E";
  c[5][2] = "E"; // seams between stones
  c[3][2] = "E";
  return toRows(c);
}
const rockCairn = buildCairn();

/** Anchor: a balanced three-stone cairn. */
function buildRockBoulder() {
  const c = canvas(16, 11);
  ellipse(c, 8, 10, 6.5, 1.1, "E");

  ellipse(c, 8, 8, 6, 2.1, "Q");
  ellipse(c, 6, 7, 3.5, 1, "q");
  for (let x = 3; x <= 13; x++) if (c[9][x] === "Q") c[9][x] = "E";
  c[7][3] = "E";
  c[8][2] = "E";
  c[8][14] = "E";
  c[8][3] = "E";
  c[8][13] = "E";

  ellipse(c, 7, 5, 4, 1.7, "q");
  ellipse(c, 6, 4, 2.3, 0.9, "Q");
  for (let x = 4; x <= 10; x++) if (c[6][x] === "q") c[6][x] = "E";
  c[5][10] = "o";

  ellipse(c, 9, 2, 2.4, 1.1, "q");
  c[1][9] = "Q";
  c[2][8] = "Q";
  c[3][9] = "E";
  return toRows(c);
}
const rockBoulder = buildRockBoulder();

// ===========================================================================
// COMPOST CORNER — leaf litter + humus mounds (wilted/exiting workers slump here).
// Dead leaves span the muted warm range (olive g, brown s/m, faded gold H); humus
// is dark soil (D/E). No new colors — reuses the earth + a faded sunflower gold.
// ===========================================================================

/** A single fallen leaf (flat, dead) — body `ch`, vein `vein`. */
function fallenLeaf(c, x, y, ch, vein) {
  ellipse(c, x, y, 1.8, 1.1, ch);
  if (c[y]?.[x] !== undefined) c[y][x] = vein;
  if (c[y]?.[x + 1] !== undefined && c[y][x + 1] !== ".") c[y][x + 1] = vein;
}
function buildCompostLeaf() {
  const c = canvas(6, 5);
  fallenLeaf(c, 3, 2, "s", "m");
  c[1][4] = "m"; // stalk tip
  return toRows(c);
}
const compostLeaf = buildCompostLeaf();

/** A scatter of mixed dead leaves. */
function buildCompostLitter() {
  const c = canvas(12, 5);
  fallenLeaf(c, 2, 2, "g", "s");
  fallenLeaf(c, 6, 3, "H", "m");
  fallenLeaf(c, 9, 2, "m", "s");
  fallenLeaf(c, 5, 1, "s", "m");
  return toRows(c);
}
const compostLitter = buildCompostLitter();

/** A bare twig with one clinging leaf. */
function buildCompostTwig() {
  const c = canvas(9, 4);
  line(c, 0, 3, 8, 1, "b"); // twig
  c[2][4] = "m"; // knot
  fallenLeaf(c, 6, 1, "H", "s"); // clinging leaf
  return toRows(c);
}
const compostTwig = buildCompostTwig();

/** A small humus mound with leaf bits pressed into it. */
function buildCompostMound() {
  const c = canvas(10, 6);
  ellipse(c, 5, 5, 5, 1.9, "E");
  ellipse(c, 5, 4, 4, 1.4, "D");
  c[3][2] = "g"; // leaf bits
  c[3][6] = "H";
  c[2][4] = "s";
  c[4][8] = "m";
  return toRows(c);
}
const compostMound = buildCompostMound();

/** Anchor: a simple wooden compost-bin frame, half-full. */
function buildCompostHeap() {
  const c = canvas(18, 12);
  ellipse(c, 9, 11, 7.5, 1.1, "E");
  rect(c, 4, 8, 13, 10, "D");
  ellipse(c, 9, 8, 5.5, 1.2, "D");
  const bits = [
    [6, 8, "g", "s"],
    [9, 7, "H", "m"],
    [12, 8, "m", "s"],
    [8, 9, "s", "m"],
  ];
  for (const [x, y, ch, vein] of bits) fallenLeaf(c, x, y, ch, vein);

  line(c, 3, 5, 3, 11, "b");
  line(c, 14, 5, 14, 11, "b");
  line(c, 4, 5, 13, 5, "m");
  line(c, 4, 8, 13, 8, "m");
  line(c, 4, 11, 13, 11, "b");
  line(c, 6, 6, 6, 10, "s");
  line(c, 10, 6, 10, 10, "s");
  c[5][3] = "o";
  c[5][14] = "o";
  c[11][3] = "o";
  c[11][14] = "o";
  return toRows(c);
}
const compostHeap = buildCompostHeap();

// ===========================================================================
// SHARED — a worn-ground / path segment usable by every biome (the trodden
// "stage" the actors walk). Quiet packed earth (D/E) with a few embedded pebbles.
// ===========================================================================

/** A worn path segment: packed dirt, darker ruts, a few embedded pebbles. */
function buildPathWorn() {
  const c = canvas(20, 6);
  ellipse(c, 10, 3, 10, 2.4, "D"); // packed dirt
  ellipse(c, 10, 4, 9, 1.6, "E"); // darker lower ruts
  ellipse(c, 10, 3, 6, 1.1, "D"); // worn-smooth centre
  // embedded pebbles + specks.
  c[2][4] = "q";
  c[2][5] = "Q";
  c[3][14] = "q";
  c[2][11] = "q";
  c[3][8] = "E";
  return toRows(c);
}
const pathWorn = buildPathWorn();

// --- exports ---------------------------------------------------------------

export const BIOME_FRAMES = {
  meadowTuft,
  meadowTuftTall,
  meadowClover,
  meadowDaisy,
  meadowPebbles,
  tideStone,
  tideStoneSm,
  tideLily,
  tideReed,
  tideRipple,
  tidePool,
  fernFrond,
  fernPair,
  fernMoss,
  fernShoot,
  fernClump,
  sunflowerHead,
  sunflowerBud,
  sunflowerStalk,
  sunflowerSprout,
  sunflowerTall,
  mushroomCap,
  mushroomPair,
  mushroomTiny,
  mushroomSpores,
  mushroomCluster,
  rockStone,
  rockStoneSm,
  rockRaked,
  rockCairn,
  rockBoulder,
  compostLeaf,
  compostLitter,
  compostTwig,
  compostMound,
  compostHeap,
  pathWorn,
};

// Grouped metadata: which tiles belong to each biome, and the worker `variant`
// whose sprite must stay readable on that ground (the contrast check). Emitted to
// atlas.gen.ts as BIOME_TILE_SETS so VUH-495 can scatter by biome. `label` drives
// the contact-sheet scene band; order here is the atlas + review order.
export const BIOME_SETS = [
  {
    name: "meadow",
    label: "MEADOW",
    variant: "green",
    tiles: ["meadowTuft", "meadowTuftTall", "meadowClover", "meadowDaisy", "meadowPebbles"],
    anchors: [],
  },
  {
    name: "tide",
    label: "TIDEPOOLS",
    variant: "teal",
    tiles: ["tideStone", "tideStoneSm", "tideLily", "tideReed", "tideRipple"],
    anchors: ["tidePool"],
  },
  {
    name: "fern",
    label: "FERN HOLLOW",
    variant: "dusk",
    tiles: ["fernFrond", "fernPair", "fernMoss", "fernShoot"],
    anchors: ["fernClump"],
  },
  {
    name: "sunflower",
    label: "SUNFLOWER",
    variant: "amber",
    tiles: ["sunflowerHead", "sunflowerBud", "sunflowerStalk", "sunflowerSprout"],
    anchors: ["sunflowerTall"],
  },
  {
    name: "mushroom",
    label: "MUSHROOM GROVE",
    variant: "green",
    tiles: ["mushroomCap", "mushroomPair", "mushroomTiny", "mushroomSpores"],
    anchors: ["mushroomCluster"],
  },
  {
    name: "rock",
    label: "ROCK GARDEN",
    variant: "green",
    tiles: ["rockStone", "rockStoneSm", "rockRaked", "rockCairn"],
    anchors: ["rockBoulder"],
  },
  {
    name: "compost",
    label: "COMPOST CORNER",
    variant: "dusk",
    tiles: ["compostLeaf", "compostLitter", "compostTwig", "compostMound"],
    anchors: ["compostHeap"],
  },
  // Shared worn-ground tile, usable by every biome (not a biome of its own).
  {
    name: "shared",
    label: "SHARED PATH",
    variant: "green",
    tiles: ["pathWorn"],
    anchors: [],
  },
];

// Atlas + GardenFrameName order (appended after the base + lifecycle frames).
export const BIOME_FRAME_ORDER = BIOME_SETS.flatMap((s) => [...s.tiles, ...s.anchors]);
