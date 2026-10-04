# Desktop pet art brief

Owner: the art worker hired from Herdr pane `w3Z:p19` (lead and harvest owner).
Scope changes: James, through the lead.

## Why a Claude worker

Pixel-art character animation is visual specialty work, which is the exception
to the current Codex-default worker rule.

## Result

Clankie is getting a macOS desktop pet: a small native overlay where he walks
when dragged, hops when hovered, blinks, idles, and sleeps when nothing's going
on. The overlay is resizable at integer scales (2×–6×). The playable
prototype and design are at https://claude.ai/artifact/HiRjtPWAjaqJLFGxo4doa3.
Its frames are derived in code and only prove the feel. This brief is for the
real frames.

The source character is `branding/clankie-logo-512-alpha.png`. It's a 22×28
grid at 12px per pixel, starting at offset (4, 4). Its palette:

| Role       | Hex       |
| ---------- | --------- |
| leaf light | `#c6d668` |
| leaf dark  | `#7d8f41` |
| stem       | `#6f5f36` |
| frame      | `#806440` |
| outline    | `#503b2c` |
| face       | `#f2e5c8` |
| eyes       | `#262f3a` |
| cheeks     | `#f3b2a4` |
| face shade | `#e3d3ae` |
| body       | `#dfddb6` |
| body shade | `#b2ae7e` |

Keep his silhouette, proportions and palette. If you add a color (for the
handheld, an unplugged cord, or a highlight), keep it to a few and list them.
The sprout is his main expressive channel: it droops when he's asleep, perks up
when he needs attention, and spins while he thinks. Codex's pets inspired his
look, so every frame here must be original. Don't trace or copy any Codex pet
sprite.

## Animations

All frames share one cell size of your choosing (around 32×40) with a fixed foot
baseline and horizontal center, so switching animations never makes him jump.
Each loop has to cycle without a pop.

| Tag                       | Frames   | Notes                                                                                          |
| ------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `idle`                    | 2–4      | Breathing; an occasional small fidget is welcome                                               |
| `blink`                   | 2        | Half-closed, then closed; plays over idle                                                      |
| `look_left`, `look_right` | 1 each   | Eyes glance sideways                                                                           |
| `walk_left`, `walk_right` | 4–6 each | Plays while he's dragged; sprout trails behind the motion                                      |
| `hop`                     | 4        | Crouch, rise, apex, land squash; plays on hover                                                |
| `fall_asleep`             | 2–3      | Yawn and droop, leading into `sleep`                                                           |
| `sleep`                   | 2–4      | Eyes shut, sprout drooped, slow breathing (the app draws the z's)                              |
| `wake`                    | 2–3      | Stretch back up to `idle`                                                                      |
| `think`                   | 4        | Sprout spins like a propeller                                                                  |
| `talk`                    | 3        | Mouth shapes over the idle body                                                                |
| `play`                    | 2–4      | Holds a tiny handheld console, looks down, presses a button                                    |
| `alert`                   | 2–3      | Sprout perks up, small bounce (the app draws the "!")                                          |
| `happy`                   | 2        | Content eyes, stronger blush                                                                   |
| `catch`                   | 2        | Arms up while a file is dragged over him                                                       |
| `offline`                 | 1–2      | Slumped or seated with a tiny unplugged cord. It must read as "can't reach him", not as asleep |

Worker minis follow him while his fleet works. They need their own half-size
sprite (about 12×14), not a downscale: `mini_idle` (2 frames) and `mini_walk`
(4 frames). Paint the regions the app will tint per worker in one flat mask color,
and document which color that is.

## Deliverables (only inside `branding/pet/`)

- Editable sources, one per frame or one per animation: text pixel grids, a
  generator script, or layered PNGs. A reviewer must be able to change a frame
  without reverse-engineering a sheet.
- `clankie-pet.png` at 1× and `clankie-pet.json` in Aseprite's array export
  format (`frames` with `duration`, `meta.frameTags` with `direction`). Same
  pair for the minis, or the minis included in the same sheet.
- `preview/`: an animated GIF per tag at 6× with nearest-neighbor scaling, and one
  contact sheet PNG showing every frame labelled.
- `README.md`: cell size, baseline, palette (including additions), tint mask
  color, tag list with durations, and how to regenerate.

## Acceptance

- Every tag above exists and loops or transitions cleanly at 1× and 6×.
- His character matches the logo: same face, sprout, colors and proportions.
- No frames come from any external sprite.
- You looked at your own GIFs and contact sheet before reporting. Say what you
  checked and what still looks weak.

## Boundaries

Write only under `branding/pet/`. Another agent works in this checkout, so don't
touch other paths and don't commit. The lead reviews and lands the work. Use
whatever local tools you need (Python with Pillow through `uv run --with pillow`
works here). If something blocks you, stop and say what.

## Report

When you're done, reply in your pane with a few lines: the outcome, paths to the
contact sheet and GIFs, any added colors, what's weakest, and any decision you
need from the lead.
