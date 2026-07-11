# Garden art assets

Pixel art for the operational-garden UI: the clankie character in four leaf
variants with a full tagged animation set, garden props, and a composed demo
scene. The character lives on the canonical 24×28 grid of the clankies
pipeline (`clankies/apps/mobile/scripts/garden-sprites/frames.mjs`), so grids
port 1:1 into the VUH-708 pipeline; base poses are ported byte-exact from the
original atlas and extended here.

Every asset ships as a `.aseprite` source plus PNG export. Character files
carry all animations as Aseprite tags with per-frame durations; the tracked
GIF per variant is the idle cycle.

## Animations

Directional scheme (VUH-753, 3-pose/4-way): front = down, back = up, side is
authored facing right and runtime-mirrored for left. Stationary states stay
front-facing.

| Tag | Frames | What it does |
| --- | --- | --- |
| `idle` | 4 | long holds, a rare 1px crown sway, snappy blink |
| `walk` | 4 | contact/passing cycle; crown lags left/right on the passing frames |
| `work` | 4 | dig: wind-up, fast swing, impact (squash + dust flecks), recover beat |
| `carry` | 4 | leaf held overhead; body bobs toward it while the leaf floats and lags |
| `blocked` | 2 | hands up, worried; eyes glance sideways on the second beat |
| `sleep` | 4 | soft half-mast crown (distinct from wilt), slow 3-phase breath |
| `wilt` | 2 | fully flopped crown, slow sag — the failed/dying state |
| `poof` | 3 | dust-cloud disappearance |
| `walk-side` / `walk-back` | 4 | same counts/timing as front `walk` |
| `carry-side` / `carry-back` | 4 | same counts/timing as front `carry` |

## Inventory

| Asset                                            | Size             | Files                                  |
| ------------------------------------------------ | ---------------- | -------------------------------------- |
| `clankie-green` / `-teal` / `-amber` / `-purple` | 24×28, 43 frames | `.aseprite`, `.png`, `.gif` (idle)     |
| `prop-mushroom`                                  | 11×10            | `.aseprite`, `.png`                    |
| `prop-grass`                                     | 5×12             | `.aseprite`, `.png`                    |
| `prop-rocks`                                     | 15×12            | `.aseprite`, `.png`                    |
| `prop-sprig`                                     | 5×10             | `.aseprite`, `.png`                    |
| `garden-scene`                                   | 160×90, 3 layers | `.aseprite`, `.png`, `-x5.png` preview |

## Palette

Base (all clankies): face `#f2e5c8`, outline `#503b2c`, bezel/stem `#806440`,
body `#dfddb6`/`#b2ae7e`, eyes `#262f3a`, cheeks `#f3b2a4`, cloud/dust
`#e8ece4`/`#b9c0b4`, scene night background `#242a2e`.

Leaf variants (light/dark): green `#c6d668`/`#7d8f41`, teal `#63d0bd`/`#34988c`,
amber `#f0b24a`/`#c47a2c`, purple `#b79ce2`/`#7d5cb0`.

## Tools

Sprite grids live as string art in `tools/frames.py` — the source of truth for
all character frames, palettes, and animation timing. `tools/gen_program.py`
emits a JSON program of pixel-mcp (Aseprite MCP) tool calls covering every
tracked asset; `tools/mcp_drive.py` executes it against the server over stdio.
Output is deterministic — regenerated files are byte-identical.

Requires Aseprite plus the pixel-mcp binary (`~/dev/pixel-mcp/bin/pixel-mcp`,
override with `PIXEL_MCP_BIN`).

```sh
# from assets/garden — regenerates everything in place
python3 tools/gen_program.py && python3 tools/mcp_drive.py run program.json

# fast iteration: upscaled strips + gifs into review/ (untracked)
python3 tools/render_review.py walk sleep          # specific animations
python3 tools/render_review.py --mirror walk-side  # runtime left-facing check
python3 tools/render_review.py --sheet             # contact sheet by direction
```

Regeneration byproducts (`program.json`, `*-x8` previews, `*-idle.aseprite`
gif staging, `review/`) are transient and not tracked. To edit a sprite,
change its grid in `frames.py` and rerun — treat the generator, not the
binary files, as the source of truth.

## Review process

Art merges only through review — no self-approved art. Draft grid changes in
`frames.py`, render strips/gifs with `render_review.py`, get the batch signed
off on the rendered pixels, then bake with `gen_program.py` and commit source
+ regenerated artifacts together. Side-pose changes also get a `--mirror`
render to prove the left-facing runtime mirror holds.
