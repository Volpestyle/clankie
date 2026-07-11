// Garden sprite palette — authoritative colors for the leaf guy (and biomes).
// The iOS icon + README header are now derived from the live game sprites
// (frames.mjs + this palette) so everything stays on-model. '.' is transparent.

/** @type {Record<string, [number, number, number, number]>} */
export const PALETTE = {
  o: [0x50, 0x3b, 0x2c, 0xff], // outline (dark warm brown)
  k: [0xdf, 0xdd, 0xb6, 0xff], // suit khaki-cream
  K: [0xb2, 0xae, 0x7e, 0xff], // suit shade (lower torso, feet)
  f: [0xf2, 0xe5, 0xc8, 0xff], // face + head-frame warm cream
  d: [0xe3, 0xd3, 0xae, 0xff], // face shade
  m: [0x80, 0x64, 0x40, 0xff], // mid warm brown (face inset border, stem light)
  e: [0x26, 0x2f, 0x3a, 0xff], // eyes (dark slate-navy)
  p: [0xf3, 0xb2, 0xa4, 0xff], // cheeks pink
  l: [0xc6, 0xd6, 0x68, 0xff], // leaf light (green base; swapped per variant)
  g: [0x7d, 0x8f, 0x41, 0xff], // leaf dark  (green base; swapped per variant)
  s: [0x6f, 0x5f, 0x36, 0xff], // stem (warm olive-brown)
  b: [0x4f, 0x3b, 0x1c, 0xff], // dark leather brown (satchel accessory)
  w: [0xe8, 0xec, 0xe4, 0xff], // poof cloud
  W: [0xb9, 0xc0, 0xb4, 0xff], // poof cloud shade
  D: [0x6b, 0x51, 0x38, 0xff], // dirt
  E: [0x57, 0x42, 0x2e, 0xff], // dirt dark
  q: [0x6e, 0x6f, 0x66, 0xff], // pebble gray
  Q: [0x8a, 0x8b, 0x80, 0xff], // pebble light
  y: [0xf2, 0xe5, 0xc8, 0xff], // glyph body (matches face cream)
  // Accessory colors (used directly in accessory grids; never variant-swapped).
  // Teal cap + dusk hood reuse their variant leaf hues so the trinket reads as
  // the same identity color; the amber satchel is brown leather with a gold clasp.
  t: [0x63, 0xd0, 0xbd, 0xff], // teal accessory light (knit-cap cuff)
  T: [0x34, 0x98, 0x8c, 0xff], // teal accessory dark  (knit-cap dome)
  a: [0xf0, 0xb2, 0x4a, 0xff], // amber accessory light (sun-hat brim)
  u: [0xb7, 0x9c, 0xe2, 0xff], // dusk accessory light (hood lining)
  U: [0x7d, 0x5c, 0xb0, 0xff], // dusk accessory dark  (hood shell)

  // Watering-can accessory (VUH-539 avatar prop; drawn directly, never variant-
  // swapped). Neutral cool pewter body so the can never fights the avatar's gold
  // leaf tint or smears the silhouette; one marker-gold band ties it to its gold-1
  // owner (matches the gold variant's leaf-dark, so "my can's band is my color").
  n: [0x9c, 0xa4, 0xa8, 0xff], // watering-can tin body (cool pewter light)
  N: [0x67, 0x70, 0x74, 0xff], // watering-can tin shade (pewter underside / right)
  r: [0xc9, 0xa3, 0x4e, 0xff], // watering-can gold accent (marker gold = gold variant leaf-dark)

  // --- Biome decoration colors (VUH-494) ------------------------------------
  // Ground tiles for the seven biomes (scripts/garden-sprites/biomes.mjs). Held
  // deliberately QUIETER than the actors: lower-saturation earth/water tones so
  // the leaf guys stay the story and the ground stays the stage. Decoration
  // foliage never uses the actors' bright leaf 'l' — it uses the muted 'g'/'s'.
  // Each key lists the biome that needed it; extend only when a biome truly does.
  c: [0x3c, 0x7d, 0x72, 0xff], // Tidepools — water (muted teal, quieter than the teal worker)
  C: [0x29, 0x50, 0x49, 0xff], // Tidepools — water deep (pool shadow / depth band)
  v: [0x55, 0x68, 0x4f, 0xff], // Fern Hollow — moss (cool muted green; reads dusk-shade, not warm meadow olive, and contrasts the violet dusk worker)
  V: [0x3d, 0x4c, 0x39, 0xff], // Fern Hollow — moss deep (frond shade / underside)
  G: [0xc6, 0x8a, 0x3a, 0xff], // Sunflower Field — petal gold (muted ochre; held duller/darker than the amber worker a=#f0b24a so it stays readable on its field)
  H: [0x9c, 0x6b, 0x2c, 0xff], // Sunflower Field — petal shade / disc rim
};

/** Background the garden renders on (matches the icon's slate). */
export const GARDEN_BACKGROUND = "#242a2e";

// Per-variant leaf tint. The generator swaps ONLY the body 'l'/'g' cells
// (head sprout + chest clover) to these when rendering a non-green worker; the
// suit/face/outline stay on the icon palette, and the carried leaf on the carry
// frames is held green (the generator keeps the top l/g band of a carry pose).
// green is the base (no swap). Hues chosen well-separated on the color wheel —
// yellow-green / aqua / amber / violet / blue — so the harness workers read apart
// at a glance while staying obviously the same character (see docs/garden-view.md).
// `gold` is the tap-to-move AVATAR's own identity (VUH-539) — not a harness
// variant, so no worker is ever tinted gold; it reuses the same l/g swap so the
// avatar reads as the same leaf guy in marker gold (matches its destination-ping
// tint, so "my ping is my color"). The darker #c9a34e underleaf keeps figure-
// ground against both the cream face and the dark ground.
//
// `onyx` is the exception: Discord text/voice presence panes render as a
// full-figure charcoal "shadow" leaf guy, not just a leaf swap. Its tint carries
// a `recolor` map that the generator applies to EVERY body palette key (outline,
// suit, face, stem, eyes, cheeks, poof), remapping the warm base tones onto one
// cool monochrome ramp. The ramp is deliberately cool-neutral and lands its
// lightest fills near #9da7b1 so the shadow figure still holds figure-ground
// against the dark garden ground (#242a2e) — a near-black outline over light-gray
// fills, not a black blob that smears into the background.
//
// `azure` is xAI/Grok's separate identity: a leaf-only frost-blue tint. It stays
// compatible with the standard body silhouette so Grok no longer squats on the
// onyx presence silhouette.
/**
 * @typedef {[number, number, number, number]} Rgba
 * @typedef {{ l: Rgba, g: Rgba, recolor?: Record<string, Rgba> }} VariantTint
 * @type {Record<string, VariantTint | null>}
 */
export const VARIANT_TINTS = {
  green: null,
  teal: { l: [0x63, 0xd0, 0xbd, 0xff], g: [0x34, 0x98, 0x8c, 0xff] },
  amber: { l: [0xf0, 0xb2, 0x4a, 0xff], g: [0xc4, 0x7a, 0x2c, 0xff] },
  dusk: { l: [0xb7, 0x9c, 0xe2, 0xff], g: [0x7d, 0x5c, 0xb0, 0xff] },
  onyx: {
    // Leaf cells (identity dot + minimap swatch source). Light gray sprout over a
    // charcoal underleaf keeps the head/chest reading as leaves on the mono body.
    l: [0x9d, 0xa7, 0xb1, 0xff],
    g: [0x2c, 0x31, 0x38, 0xff],
    // Full-figure charcoal remap — one cool ramp, darkest → lightest. Every body
    // key the frames use (K W d e f k m o p s w) MUST appear here or the
    // generator throws, so a shadow worker can never leak a warm base pixel.
    recolor: {
      o: [0x15, 0x18, 0x1c, 0xff], // outline → near-black cool
      e: [0x15, 0x18, 0x1c, 0xff], // eyes → darkest (still read on the light face)
      K: [0x2c, 0x31, 0x38, 0xff], // suit shade → deep charcoal
      s: [0x2c, 0x31, 0x38, 0xff], // stem → deep charcoal
      m: [0x40, 0x47, 0x4f, 0xff], // mid border → mid charcoal
      k: [0x5a, 0x63, 0x6c, 0xff], // suit → mid slate gray
      d: [0x7d, 0x87, 0x91, 0xff], // face shade → light-mid gray
      p: [0x7d, 0x87, 0x91, 0xff], // cheeks → mono (subtle face-shade patch)
      f: [0x9d, 0xa7, 0xb1, 0xff], // face → light cool gray (the silhouette carrier)
      W: [0x7d, 0x87, 0x91, 0xff], // poof shade → light-mid gray
      w: [0xbb, 0xc4, 0xcc, 0xff], // poof → lightest cool gray
    },
  },
  azure: { l: [0x8f, 0xc9, 0xff, 0xff], g: [0x4a, 0x73, 0xb8, 0xff] },
  gold: { l: [0xf0, 0xd6, 0x96, 0xff], g: [0xc9, 0xa3, 0x4e, 0xff] },
};

/** Variant order (green first = base; onyx/azure/gold last). Drives generation + type union. */
export const VARIANTS = ["green", "teal", "amber", "dusk", "onyx", "azure", "gold"];
