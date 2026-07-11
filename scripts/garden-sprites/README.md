# Garden sprite pipeline

Hand-editable pixel art for the garden view, compiled into one atlas the app
renders via the Skia `Atlas` API. `docs/garden-view.md` describes how the app
consumes it; this file is the authoring and review side.

## Files

| File                    | Role                                                                                                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frames.mjs`            | Character pixel grids (leaf guy poses, stump, jobsite, glyphs) and the shared geometry contract. Source of truth for the character.                                                                                                                 |
| `lifecycle.mjs`         | Poses derived from the character rows (wilt, germinate) — imports the shared row constants from `frames.mjs`, never copies them.                                                                                                                    |
| `biomes.mjs`            | Biome decoration tiles (`BIOME_FRAMES`/`BIOME_SETS`). Fully self-contained: own drawing helpers, no character-geometry imports, references only `PALETTE` keys.                                                                                     |
| `totems.mjs`            | Skill-totem art + lead badge (`TOTEM_FRAMES`): one carved totem silhouette, a vocabulary of 8×8 per-skill glyphs that overlay its cream face, and the gold `leadCrown` circlet. Self-contained like `biomes.mjs`; all props (never variant-tinted). |
| `palette.mjs`           | The palette, sampled from the real app icon, plus sectioned biome extensions.                                                                                                                                                                       |
| `generate.mjs`          | The atlas build: emits `assets/garden-atlas/{leafguy-atlas.png,atlas.gen.ts,contact-sheet.png}`. Run with `pnpm garden:atlas`.                                                                                                                      |
| `preview-biomes.mjs`    | Standalone review renderer: biome sets only, grouped and labeled, to a PNG path of your choice. Not on the generator path — safe while the atlas is frozen.                                                                                         |
| `preview-totems.mjs`    | Standalone review renderer: the totem carved with each skill glyph, the glyph vocabulary large on a cream face, and the lead circlet alone + worn on a head.                                                                                        |
| `preview-contrast.mjs`  | Standalone review renderer: each harness-variant sprite standing on its own territory's ground tiles, for the readability check.                                                                                                                    |
| `preview-avatar.mjs`    | Standalone review renderer for the avatar and watering-can accessory at several garden zoom levels.                                                                                                                                                 |
| `preview-signposts.mjs` | Standalone review renderer for signpost treatments and dynamic labels.                                                                                                                                                                              |

Preview renderers take an optional output PNG path, for example:

```bash
node scripts/garden-sprites/preview-biomes.mjs /tmp/biomes-preview.png
```

## Pipeline

Edit grids → render a standalone preview for review → on sign-off run
`pnpm garden:atlas` → commit source + regenerated artifacts together.

`pnpm garden:atlas` is a **publishing step**, not a build cache: it bakes the
current state of every source file — including anyone's uncommitted WIP — into
the atlas the app renders. Check the source files' provenance before running
it, and keep a single regeneration owner when multiple agents share the tree.
The generated manifest exports frame, animation, anchor, palette, and variant
recolor data; it does not import the authoring scripts at runtime.

## Visual rules

- Flat colors on the slate background. No gradients, glow, shadows, or new
  outline styles. Nearest-neighbor sampling; integer pixel grid.
- Palette discipline: extend `palette.mjs` only when a set genuinely needs a
  color, keep additions muted, and document each key's purpose next to it.
- **Figure/ground:** decoration reads quieter than the actors. Ground foliage
  uses the muted `g`/`s` tones, never the actors' bright leaf `l`; anchors stay
  duller than the variant accent they share a territory with.
- **Territory contrast:** a variant-tinted sprite must stay clearly readable on
  its own biome's ground (teal on Tidepools, amber on Sunflower Field, dusk on
  Fern Hollow; onyx/azure on Meadow). If it vanishes, fix the ground, not the
  sprite.
- **Charm over parity:** for character work, the leaf guy's stubby charm
  outranks icon-accuracy. Prefer single targeted tweaks over re-proportions.

## Review process

Art merges only through review — no self-approved art:

1. Draft a small batch (one or two sets), render it with `preview-biomes.mjs`.
2. The reviewer judges the rendered pixels per set against the rules above and
   returns per-tile verdicts; revise and re-render until the batch is signed
   off. Lock direction with the first batch before drafting the rest.
3. After all batches: render the contrast strip (`preview-contrast.mjs`) and
   pass it, then run the gated `pnpm garden:atlas`, confirm the contact sheet,
   and verify existing character frames are pixel-unchanged by the repack.
