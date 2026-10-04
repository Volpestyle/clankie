# Clankie desktop pet sprites

Frame art for the macOS desktop pet. Every frame is drawn from Clankie's logo
grid (`branding/clankie-logo-512-alpha.png`: 22×28 cells, 12 px each, figure at
pixel offset (124, 108)). Nothing comes from an external sprite.

## Files

| Path                         | What                                                                      |
| ---------------------------- | ------------------------------------------------------------------------- |
| `src/palette.txt`            | One-character palette keys used by every grid                             |
| `src/pet/<tag>.txt`          | Main character, one file per animation, one text grid per frame           |
| `src/mini/<tag>.txt`         | Worker minis, same format                                                 |
| `build.py`                   | Renders the grids into everything below                                   |
| `clankie-pet.png` / `.json`  | Main sheet, 1×, one row, Aseprite array JSON                              |
| `clankie-mini.png` / `.json` | Mini sheet, same format                                                   |
| `preview/<tag>.gif`          | Each tag at 6×, nearest-neighbour, on a flat warm background              |
| `preview/contact-sheet.png`  | Every frame at 4×, labelled, with center (blue) and baseline (red) guides |

## Regenerate

```sh
uv run --with pillow python3 branding/pet/build.py
```

To change a frame, edit its grid in `src/` and rebuild. A tag file looks like:

```
# idle: comment
direction forward        # Aseprite tag direction
repeat 1                 # optional: one-shot tags (Aseprite 1.3 "repeat")
frame 500                # duration in ms, then exactly H rows of W characters
................................
```

The build fails on a wrong row width, row count or unknown palette key. Tag
order in the sheet comes from `SHEETS` in `build.py`. Frame indices in the JSON
come from the files, so adding or removing frames needs no other change.

The text grids are the only source. Nothing regenerates them, so hand edits
are safe.

### Editing the walk cycle

`walk_left` and `walk_right` are separate files: `src/pet/walk_left.txt` and
`src/pet/walk_right.txt`. Editing one never changes the other.

1. Each frame is a `frame <ms>` line followed by exactly 40 rows of exactly 32
   characters. Use only keys from `src/palette.txt`; `.` is transparent.
2. Keep the feet planted on row 38. Counting from 0 that's the 39th row, the
   last non-empty one. Keep the body centered on the line between columns 15
   and 16 so switching tags doesn't make him jump. A raised foot can end higher.
3. To add a frame, copy a whole `frame` block (the line and its 40 rows) and
   paste it where it belongs in the order. To remove one, delete the whole
   block. Changing a `frame` number changes only that frame's duration.
4. Rebuild with `uv run --with pillow python3 branding/pet/build.py` (from the
   repo root). Check `preview/walk_left.gif`, `preview/walk_right.gif` (6×) and
   `preview/contact-sheet.png`. The red guide is the baseline and the blue one
   the center.
5. `clankie-pet.json` picks up the new frame range automatically. Every tag
   after the walk moves to new indices, so an app that reads frames by tag name
   needs no change.

Current layout, for orientation: the walk frames face their travel direction
in a 3/4 turn. The head and face are drawn 1.5 px toward the direction, with the
side of the head on the trailing side. The near leg and arm lead, and the sprout
trails behind. Frames 0 and 2 are full strides with the head 1 px lower, and
frames 1 and 3 are passing poses. Every frame has one leg raised a row.

## Geometry

| Sheet          | Cell  | Horizontal center                    | Baseline                                          |
| -------------- | ----- | ------------------------------------ | ------------------------------------------------- |
| `clankie-pet`  | 32×40 | between columns 15 and 16 (x = 16.0) | feet end on row 38; row 39 is the first empty row |
| `clankie-mini` | 12×14 | between columns 5 and 6 (x = 6.0)    | feet on row 13 (the last row)                     |

In the standing pose the logo figure sits at cell offset (5, 11): head and body
are symmetric about the center, and the sprout keeps the logo's asymmetry. Feet
stay on the baseline in every frame except `hop` 1–2 and `alert` 1–2, which
are deliberate bounces. `walk_*` sprouts trail sideways past the body, so those
frames' bounding boxes are off-center. In the 3/4 walk the head leans 1.5 px
toward the travel direction while the torso and the stride stay centered.

## Palette

| Key | Hex       | Role                                     |
| --- | --------- | ---------------------------------------- |
| `.` | —         | transparent                              |
| `L` | `#c6d668` | leaf light                               |
| `l` | `#7d8f41` | leaf dark                                |
| `s` | `#6f5f36` | stem                                     |
| `f` | `#806440` | frame                                    |
| `o` | `#503b2c` | outline                                  |
| `c` | `#f2e5c8` | face                                     |
| `e` | `#262f3a` | eyes (also mouths, unplugged cord)       |
| `p` | `#f3b2a4` | cheeks                                   |
| `d` | `#e3d3ae` | face shade (also blink lid, plug prongs) |
| `b` | `#dfddb6` | body                                     |
| `B` | `#b2ae7e` | body shade                               |

Added colors (five):

| Key | Hex       | Role                                                                                                                 |
| --- | --------- | -------------------------------------------------------------------------------------------------------------------- |
| `r` | `#d0745a` | handheld shell (`play`)                                                                                              |
| `R` | `#a85742` | handheld shell shade: back-cover seams and grip ridges (`play`)                                                      |
| `y` | `#e6ebbf` | faint screen glow on his face (`play`)                                                                               |
| `g` | `#3c4856` | glare and scanline on the switched-off screen (`offline`)                                                            |
| `n` | `#cfc6a8` | dimmed screen while he sleeps, seated (`fall_asleep`, `sleep`); never dark, so sleep can't be mistaken for `offline` |
| `M` | `#ff00ff` | **tint mask, minis only**                                                                                            |

## Worker tint mask

Mini pixels painted `#ff00ff` (key `M`, the torso) are the region the app tints
per worker. Everything else (sprout, head, face, arms, feet) stays in Clankie's
palette so every mini reads as one of his. The mask is one flat color, so the app
should replace it outright, or multiply a worker color into it, rather than
expect shading.

## Tags

Durations are in ms. "Once" tags carry `"repeat": "1"` in the JSON. The app
decides what follows them.

| Tag           | Frames | Durations                                                          | Plays | Notes                                                                                                                                                                                                                                                                                        |
| ------------- | ------ | ------------------------------------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idle`        | 0–3    | 500, 300, 500, 300                                                 | loop  | Head settles 1 px; the sprout follows a beat late                                                                                                                                                                                                                                            |
| `blink`       | 4–5    | 60, 90                                                             | once  | Half-closed, closed; drawn on the `idle` 0 pose                                                                                                                                                                                                                                              |
| `look_left`   | 6      | 800                                                                | hold  | Eyes glance to screen-left                                                                                                                                                                                                                                                                   |
| `look_right`  | 7      | 800                                                                | hold  | Eyes glance to screen-right                                                                                                                                                                                                                                                                  |
| `walk_left`   | 8–11   | 130 ×4                                                             | loop  | 3/4 turn toward screen-left: head and face lead, side of the head shows, near arm and leg lead the stride, sprout streams behind                                                                                                                                                             |
| `walk_right`  | 12–15  | 130 ×4                                                             | loop  | 3/4 turn toward screen-right. The body mirrors `walk_left`; the sprout is re-lit so the stem's light edge stays on the left                                                                                                                                                                  |
| `hop`         | 16–19  | 90, 80, 150, 110                                                   | once  | Crouch, rise, apex (6 px up), land squash                                                                                                                                                                                                                                                    |
| `fall_asleep` | 20–22  | 450, 500, 600                                                      | once  | Yawn, droop; the last frame equals `sleep` 0                                                                                                                                                                                                                                                 |
| `sleep`       | 23–26  | 700, 500, 700, 500                                                 | loop  | Eyes shut, leaves folded down, slow breathing; app draws z's                                                                                                                                                                                                                                 |
| `wake`        | 27–29  | 400, 250, 300                                                      | once  | Stretch with arms up, half-open eyes, settle toward `idle` 0                                                                                                                                                                                                                                 |
| `think`       | 30–49  | 30 ×6, 35, 40, 45, 50, 55, 60, 70, 80, 95, 110, 130, 150, 175, 240 | loop  | Loading-spinner propeller, eyes up; all timing is in the frame durations, so the app just loops the tag (see below)                                                                                                                                                                          |
| `talk`        | 50–52  | 120 ×3                                                             | loop  | Mouth shapes on the `idle` 0 pose: small, rounded open, mid                                                                                                                                                                                                                                  |
| `play`        | 53–56  | 350, 110, 350, 110                                                 | loop  | Holds a handheld facing himself, so we see its back: cartridge in the top slot, battery cover, grip ridges, his hands on the sides. Eyes down; the game shows as a faint glow on his face that flickers between frames. The short frames are button presses: head, device and hands nod 1 px |
| `alert`       | 57–59  | 100, 140, 180                                                      | loop  | Sprout perks into a V, wide eyes, small bounce; app draws "!"                                                                                                                                                                                                                                |
| `happy`       | 60–61  | 300, 300                                                           | loop  | `^ ^` eyes, wider blush, gentle bob                                                                                                                                                                                                                                                          |
| `catch`       | 62–63  | 200, 200                                                           | loop  | Arms up (stubs, then full reach) while a file hovers                                                                                                                                                                                                                                         |
| `offline`     | 64–65  | 1400, 160                                                          | loop  | Sits slumped, screen switched off, sprout wilted, unplugged cord beside him; a scanline flickers on the dead screen                                                                                                                                                                          |
| `mini_idle`   | 0–1    | 450, 450                                                           | loop  | Breathing                                                                                                                                                                                                                                                                                    |
| `mini_walk`   | 2–5    | 120 ×4                                                             | loop  | Front-facing shuffle, direction-neutral, so no mirroring is needed                                                                                                                                                                                                                           |

### `think` timing

One 1.5 s loop. Six smear frames at 30 ms each come first: a blurred ring of
leaf streaks, with lit arcs that swap every frame so it shimmers forward. Next,
four sharp frames step 60° at 35–50 ms, then ten frames step 30° while the
durations ease out from 55 ms to 175 ms. It ends with a 240 ms near-pause on the
wide pose. The loop then snaps straight back into the smear burst. The blades are
symmetric, so every 180° is the same picture. Each sharp step continues the
same rotation, and a smear can follow any angle, so the loop has no seam.
GIF previews round durations to 10 ms steps (a GIF format limit). The JSON
keeps the exact values.

`offline` and `sleep` are meant to read differently. Sleep keeps his face lit
with closed eyes and a neatly folded sprout. Offline turns his screen dark, wilts
the sprout and shows the loose plug.
