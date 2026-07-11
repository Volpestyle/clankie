// Garden phase-4 sprite source — skill-totem art + per-run lead badge (VUH-621 /
// VUH-518 / VUH-538 art).
//
// The garden LOGIC (GardenCanvas.tsx, kinematics.ts) is owned elsewhere; this
// module owns only the ART, kept self-contained like biomes.mjs so the base
// character grids in frames.mjs stay untouched — generate.mjs merges the sources.
// Same authoring model: equal-width pixel-grid strings keyed to PALETTE, validated
// loudly by the generator. '.' = transparent (the app composites over the slate).
//
// Aesthetic contract (docs/garden-view.md):
//   • Leaf-guy-anchored identity: the totem carries the leaf guy's cream head-frame
//     (warm cream `f`, mid-brown inset `m`, dark `o` outline) and a two-leaf sprout
//     crown, so a shrine reads as garden KIN of the character, not a foreign asset.
//   • Flat colors on slate. No gradients, glow, shadows, or new outline styles.
//     Nearest-neighbor / integer grid.
//   • Figure/ground: the totem body sits in the quiet earth/wood range so the
//     bright leaf `l` stays unique to the actors; only its little sprout crown uses
//     `l`/`g` (and GardenCanvas MAY tint that crown to the skill's accent, the same
//     l/g swap the harness variants use — optional, flagged for the logic slice).
//
// Each frame here is a PROP: rendered green (base palette), never variant-tinted.

// --- shared canvas helpers (self-contained; mirrors biomes.mjs) -------------

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

// ===========================================================================
// SKILL TOTEM — a carved garden shrine (VUH-621 / VUH-518).
//
// A stubby wooden post with a cream carved FACE panel (echoes the leaf-guy head:
// cream field `f`, mid-brown `m` inset frame, dark `o` outline) topped by a small
// two-leaf sprout crown, sunk in a dirt mound. The face is left blank here — a
// per-skill glyph (below) overlays it at TOTEM_GLYPH_ANCHOR the same way the
// harness accessory rides ACCESSORY_ANCHOR, so one silhouette serves every skill.
// ===========================================================================

const TOTEM_W = 18;
const TOTEM_H = 26;

function buildTotem() {
  const c = canvas(TOTEM_W, TOTEM_H);

  // --- dirt mound the post is planted in (drawn first, post covers its middle) --
  ellipse(c, 8.5, 24, 8, 2.6, "E");
  ellipse(c, 8.5, 23, 7, 2.1, "D");
  ellipse(c, 8.5, 25, 5, 1.2, "E");

  // --- post body: outlined warm-wood plinth, cols 3..14, rows 6..22 -----------
  // Solid wood first; the cream face is carved back into it below.
  rect(c, 3, 6, 14, 22, "o"); // outline block
  rect(c, 4, 7, 13, 21, "s"); // wood interior (warm olive-brown)
  // Lit left edge + a couple of vertical grain hints so the post is not a flat slab.
  rect(c, 4, 7, 4, 21, "m");
  c[9][6] = "m";
  c[13][11] = "m";
  c[17][7] = "m";

  // --- carved cream face panel: recessed frame `m`, cream field `f` -----------
  // Frame (mid-brown lintel/sill/jambs) then the cream field inside it.
  rect(c, 4, 9, 13, 18, "m"); // recessed frame
  rect(c, 5, 10, 12, 17, "f"); // cream field (8x8 — the glyph overlays here)

  // --- two-leaf sprout crown (leaf-guy DNA) -----------------------------------
  // Short forked stem rising from the post cap into two small leaves.
  rect(c, 8, 3, 9, 6, "s");
  c[5][8] = "m";
  c[4][9] = "m";
  ellipse(c, 5, 3, 3, 1.9, "g"); // left leaf
  ellipse(c, 5, 2, 2, 1.2, "l");
  ellipse(c, 12, 3, 3, 1.9, "g"); // right leaf
  ellipse(c, 12, 2, 2, 1.2, "l");
  // Re-lay the outline cap over any leaf spill onto the post top.
  rect(c, 3, 6, 14, 6, "o");
  rect(c, 4, 7, 13, 8, "s");
  rect(c, 4, 7, 4, 8, "m");

  return toRows(c);
}
const totem = buildTotem();

// Body-local top-left where an 8x8 skill glyph sits (the cream face field).
export const TOTEM_GLYPH_ANCHOR = { x: 5, y: 10 };

// ===========================================================================
// SKILL GLYPHS — carved emblems (VUH-621). 8x8, dark `o` incised into the cream
// face. The set is a fixed VOCABULARY of distinct, charming icons — not a literal
// per-skill dictionary: because the visible totems are dynamic (skills.list,
// capped 5) GardenCanvas picks one per skill by `seed`, the same deterministic
// seed→accent path totemAccent() already uses, so the art stays frozen while the
// mapping stays data-driven. Each is a single bold silhouette (solid fills, no
// scattered single pixels) so it survives the downscale to game zoom.
// ===========================================================================

// star — a bold four-point shine.
const skillStar = [
  "...oo...",
  "...oo...",
  "..oooo..",
  "oooooooo",
  "oooooooo",
  "..oooo..",
  "...oo...",
  "...oo...",
];

// bolt — a lightning zigzag (action / kick-off).
const skillBolt = [
  "...ooo..",
  "..ooo...",
  ".ooo....",
  ".ooooo..",
  "...ooo..",
  "..ooo...",
  "..oo....",
  ".oo.....",
];

// eye — an almond eye with a solid pupil over the cream sclera (review / inspect).
const skillEye = [
  "........",
  "..oooo..",
  ".o....o.",
  "o..oo..o",
  "o..oo..o",
  ".o....o.",
  "..oooo..",
  "........",
];

// arrow — a bold up-pointer on a thin shaft (navigate / route).
const skillArrow = [
  "...oo...",
  "..oooo..",
  ".oooooo.",
  "oooooooo",
  "...oo...",
  "...oo...",
  "...oo...",
  "...oo...",
];

// drop — a water droplet, sharp top over a round belly (deploy / flow — a nod to
// the garden's watering-can identity).
const skillDrop = [
  "...oo...",
  "...oo...",
  "..oooo..",
  ".oooooo.",
  "oooooooo",
  "oooooooo",
  "oooooooo",
  ".oooooo.",
];

// leaf — a two-leaf sprout rooted in soil (create / scaffold — garden-native).
const skillLeaf = [
  "oo....oo",
  ".oo..oo.",
  "..o..o..",
  "...oo...",
  "...oo...",
  "...oo...",
  "...oo...",
  ".oooooo.",
];

// ring — a target: a ring around a solid hub (focus / dispatch).
const skillRing = [
  "..oooo..",
  ".o....o.",
  "o..oo..o",
  "o.oooo.o",
  "o.oooo.o",
  "o..oo..o",
  ".o....o.",
  "..oooo..",
];

// Ordered vocabulary — GardenCanvas indexes this by seed (floor(seed * len)).
export const SKILL_GLYPH_ORDER = [
  "skillStar",
  "skillBolt",
  "skillEye",
  "skillArrow",
  "skillDrop",
  "skillLeaf",
  "skillRing",
];

// ===========================================================================
// LEAD BADGE — a 3-tine gold circlet (VUH-538 art).
//
// A per-run lead already renders as a bigger, upright leaf guy; this overlay is
// the "presiding" mark. Gold (`a` light + `r` accent) belongs to no harness
// variant, so the crown reads as RANK on a teal/amber/dusk/onyx/azure lead alike
// without smearing the leaf identity — it rides the head brow, BELOW the sprout.
// GardenCanvas composites it at LEAD_CROWN_ANCHOR (flagged DEP for the logic slice).
// ===========================================================================

const leadCrown = [
  "o..o...o..o", // 0  tine tips (four points across the brow)
  "oo.oo.oo.oo", // 1  tines widen
  "oaaaaaaaaao", // 2  gold band (light)
  "orrrrrrrrro", // 3  gold band (accent underside)
  ".ooooooooo.", // 4  band base outline
];

// Body-local top-left where the circlet sits on the lead's head brow (below the
// sprout, over the head-frame top rim). Character head top is row 8 in the base
// geometry; the crown's 5 rows land on the rim from row 8 down.
export const LEAD_CROWN_ANCHOR = { x: 6, y: 7 };

// --- exports ---------------------------------------------------------------

export const TOTEM_FRAMES = {
  totem,
  skillStar,
  skillBolt,
  skillEye,
  skillArrow,
  skillDrop,
  skillLeaf,
  skillRing,
  leadCrown,
};

// Atlas + GardenFrameName order (appended after the biome frames).
export const TOTEM_FRAME_ORDER = ["totem", ...SKILL_GLYPH_ORDER, "leadCrown"];
