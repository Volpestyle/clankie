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
| `face-geometry.json`         | Approved body-frame offsets for the screen-only face overlays             |
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

### Screen faces (VUH-1679)

The five `face_*` tags are overlays, not replacement bodies. Each is a full
32×40 cell, transparent except for the **entire opaque 12×5 screen interior**:
x 10–21, y 23–27, inclusive, on `idle` frame 0. Covering every screen pixel
removes the underlying eyes and cheeks. Only existing face palette keys
`c`, `d`, `e`, and `p` appear; there are no added colors.

These tags are appended after `drop`, leaving all 85 existing main-sheet
indices, crops, durations and body sources unchanged. The face additions leave mini source grids unchanged; the later stem palette
polish also recolors their rendered stems. Each first frame is a distinct static expression for Reduce Motion;
the remaining frames make only small screen changes, with no body motion in
the overlays.

| Tag                | Frames | Durations (ms)  | Expression                                           |
| ------------------ | ------ | --------------- | ---------------------------------------------------- |
| `face_working`     | 85–87  | 1000, 650, 850  | Focused eyes and a quiet three-dot cadence           |
| `face_new_message` | 88–90  | 1400, 500, 1100 | Attentive eyes, a small smile and a slow blink       |
| `face_needs_you`   | 91–93  | 1600, 500, 1600 | An attentive gaze and a persistent small exclamation |
| `face_error`       | 94–96  | 1800, 600, 1800 | Crossed eyes and a frown, without flashing           |
| `face_voice`       | 97–99  | 700, 700, 700   | Calm eyes with three speaking mouth shapes           |

`face-geometry.json` is generated from the builder's validated front-view
screen map. Its top-level keys are body tag names; each array entry is the
pixel offset `{ "x": 0, "y": … }` for that body frame relative to the
overlay's `idle`-0 origin. Frame numbers are relative to their tag, not global
sheet indices. The renderer can translate the full overlay cell by this
offset at the same integer scale as the body.

| Compatible body tag | Per-frame y offsets (x is always 0) |
| ------------------- | ----------------------------------- |
| `idle`              | 0, 1, 1, 0                          |
| `blink`             | 0, 0                                |
| `think`             | 0 for all 20 frames                 |
| `talk`              | 0, 0, 0                             |
| `lead`              | 1, 0, 1, 0                          |
| `alert`             | 1, −2, −1                           |
| `hop`               | 2, −3, −6, 2                        |
| `conduct`           | 1, 0, 1, 0                          |
| `wilt`              | 0, 0, 0                             |
| `wait`              | 0 for all 5 frames                  |

All other body tags are absent from this map. In particular, do not apply a
front-facing overlay to walk, run, sleep or offline artwork. The builder
rejects a shifted/changed front-view screen, any face pixel outside its mask,
any uncovered screen pixel, fast face frames, or duplicate static first faces.

The sheet stores the transparent overlays. Their GIFs and contact-sheet rows
show each face composited on the unchanged `idle`-0 body for visual review.
The offline [frame strip](../../docs/testing/2026-10-05-pet-faces/frame-strip.png)
also checks moving body anchors and the static Reduce Motion expression.
Reproduce the art boundary evidence after rebuilding:

```sh
uv run --with pillow python3 docs/testing/2026-10-05-pet-faces/verify-art.py --baseline 05ccea2e
```

That comparison is scoped to this face addition's approved original-art
commit; later intentional body work should supply its own approved baseline.

### Working loops (VUH-1754)

Seven tags appended after the existing body art add typing (`work_type`),
reading an open book (`work_read`), writing on a clipboard (`work_write`),
tinkering with a device (`work_tinker`), listening (`voice_listen`), watching a
game (`play_watch`), and a mirrored fist-pump cheer (`play_cheer`). Each has four
editable frames, planted feet, and the existing palette. Their front-view
screens are validated with zero-offset face geometry. Rebuild with the command
above, then sync the built sheets into the app; generated outputs stay untouched
by hand. Frame timings live in the editable grids; tour cadence and selection
live in the app.

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
in a 3/4 turn. The screen sits on the leading half of the head with the eyes
pushed forward, and a seam marks the side of the box on the trailing half. The near leg and arm lead, and the sprout
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
are deliberate bounces, and `lift`, where he hangs from the pointer. `walk_*` sprouts trail sideways past the body, so those
frames' bounding boxes are off-center. In the 3/4 walk the head leans 1.5 px
toward the travel direction while the torso and the stride stay centered.

## Palette

| Key | Hex       | Role                                     |
| --- | --------- | ---------------------------------------- |
| `.` | —         | transparent                              |
| `L` | `#c6d668` | leaf light                               |
| `l` | `#7d8f41` | leaf dark                                |
| `s` | `#9e8b57` | stem; lighter on a dark desktop          |
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

| Tag           | Frames | Durations                                                          | Plays | Notes                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | ------ | ------------------------------------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idle`        | 0–3    | 500, 300, 500, 300                                                 | loop  | Head settles 1 px; the sprout follows a beat late                                                                                                                                                                                                                                                                                                                          |
| `blink`       | 4–5    | 60, 90                                                             | once  | Half-closed, closed; drawn on the `idle` 0 pose                                                                                                                                                                                                                                                                                                                            |
| `look_left`   | 6      | 800                                                                | hold  | Eyes glance to screen-left                                                                                                                                                                                                                                                                                                                                                 |
| `look_right`  | 7      | 800                                                                | hold  | Eyes glance to screen-right                                                                                                                                                                                                                                                                                                                                                |
| `walk_left`   | 8–11   | 130 ×4                                                             | loop  | 3/4 turn toward screen-left: the screen sits on the leading half of the box with the eyes pushed forward and only the near cheek showing, and a seam marks the side of the box on the trailing half. Both leaves stream behind and lag the head by a frame: high when the head drops on a stride, low when it rises on a pass, with a 1 px flutter between the two strides |
| `walk_right`  | 12–15  | 130 ×4                                                             | loop  | Mirror of `walk_left`; the stem is re-lit so its light edge stays on the left                                                                                                                                                                                                                                                                                              |
| `hop`         | 16–19  | 90, 80, 150, 110                                                   | once  | Crouch, rise, apex (6 px up), land squash                                                                                                                                                                                                                                                                                                                                  |
| `fall_asleep` | 20–22  | 450, 500, 600                                                      | once  | Yawn, droop; the last frame equals `sleep` 0                                                                                                                                                                                                                                                                                                                               |
| `sleep`       | 23–26  | 700, 500, 700, 500                                                 | loop  | Eyes shut, leaves folded down, slow breathing; app draws z's                                                                                                                                                                                                                                                                                                               |
| `wake`        | 27–29  | 400, 250, 300                                                      | once  | Stretch with arms up, half-open eyes, settle toward `idle` 0                                                                                                                                                                                                                                                                                                               |
| `think`       | 30–49  | 30 ×6, 35, 40, 45, 50, 55, 60, 70, 80, 95, 110, 130, 150, 175, 240 | loop  | Loading-spinner propeller, eyes up; all timing is in the frame durations, so the app just loops the tag (see below)                                                                                                                                                                                                                                                        |
| `talk`        | 50–52  | 120 ×3                                                             | loop  | Mouth shapes on the `idle` 0 pose: small, rounded open, mid                                                                                                                                                                                                                                                                                                                |
| `play`        | 53–56  | 350, 110, 350, 110                                                 | loop  | Holds a handheld facing himself, so we see its back: cartridge in the top slot, battery cover, grip ridges, his hands on the sides. Eyes down; the game shows as a faint glow on his face that flickers between frames. The short frames are button presses: head, device and hands nod 1 px                                                                               |
| `alert`       | 57–59  | 100, 140, 180                                                      | loop  | Sprout perks into a V, wide eyes, small bounce; app draws "!"                                                                                                                                                                                                                                                                                                              |
| `happy`       | 60–61  | 300, 300                                                           | loop  | `^ ^` eyes, wider blush, gentle bob                                                                                                                                                                                                                                                                                                                                        |
| `catch`       | 62–63  | 200, 200                                                           | loop  | Arms up (stubs, then full reach) while a file hovers                                                                                                                                                                                                                                                                                                                       |
| `offline`     | 64–65  | 1400, 160                                                          | loop  | Sits slumped, screen switched off, sprout wilted, unplugged cord beside him; a scanline flickers on the dead screen                                                                                                                                                                                                                                                        |
| `rustle`      | 66–69  | 90, 90, 90, 120                                                    | once  | Idle fidget: the leaf tips trade places twice, on the `idle` 0 pose                                                                                                                                                                                                                                                                                                        |
| `tap`         | 70–74  | 260, 110, 110, 110, 240                                            | once  | Idle fidget: looks down and taps his right foot twice                                                                                                                                                                                                                                                                                                                      |
| `lead`        | 75–78  | 7000, 600, 400, 600                                                | loop  | Directing his workers: a long rest, then a glance right with that arm raised, a beat, and the same to the left. The rest lives in the frame durations, so the gesture stays rare without app timing                                                                                                                                                                        |
| `lift`        | 79–82  | 180 ×4                                                             | loop  | Dragged up: lifted 2 px with dangling legs that swing like a pendulum, leaves pressed down, wide eyes                                                                                                                                                                                                                                                                      |
| `drop`        | 83–84  | 160, 160                                                           | loop  | Dragged down: arms up and wide eyes (`catch`), sprout streaming up in a V (`alert`) that flutters                                                                                                                                                                                                                                                                          |
| `mini_idle`   | 0–1    | 450, 450                                                           | loop  | Breathing                                                                                                                                                                                                                                                                                                                                                                  |
| `mini_walk`   | 2–5    | 120 ×4                                                             | loop  | Front-facing shuffle, direction-neutral, so no mirroring is needed                                                                                                                                                                                                                                                                                                         |

### Run and fleet beats (VUH-1681 / VUH-1680)

The seven additions start at frame 100, preserving earlier tag indices and
timings. The six-frame runs have two airborne poses and two contact squashes
per 450 ms cycle. They are editable candidates for James's run refinement;
the app's existing sideways drag still uses the authored walk. A separate
after-drop squash remains optional and is not included here.

| Tag            | Frames  | Duration                  | Playback                                             |
| -------------- | ------- | ------------------------- | ---------------------------------------------------- |
| `run_left`     | 100–105 | 90, 65, 75, 90, 65, 75 ms | loop                                                 |
| `run_right`    | 106–111 | 90, 65, 75, 90, 65, 75 ms | loop                                                 |
| `seed`         | 112–117 | 1030 ms                   | once; seed toss, then a small sproutling             |
| `conduct`      | 118–121 | 1360 ms                   | once; alternate raised leaves and directing arms     |
| `read_message` | 122–125 | 1140 ms                   | once; catch and inspect an envelope                  |
| `wilt`         | 126–128 | 1080 ms                   | once; drooping sprout with the awake screen retained |
| `wait`         | 129–133 | 730 ms                    | once; a short foot tap                               |

The app consumes fresh event IDs from an opted-in `presence` read for the seed
and report beats. Conduct, wait and wilt follow newly observed fleet, question
and continuous thinking transitions. They settle after one play; the working
or attention screen can remain. First reads, reconnects, suppressed events
and bursts do not become a queued dance. See [ADR 0220](../../docs/adr/0220-clankie-has-one-present-tense.md).

The lighter stem changes its palette pixels in existing hero and mini frames,
so their sheets and GIF previews must be regenerated together. Review every
new frame on both backgrounds in [the polish sheet](preview/polish-review.png)
and motion in its corresponding `preview/<tag>.gif`.

### Skid (momentum stop)

`skid_left` (134–137) and `skid_right` (138–141) are appended after `wait`, so
every earlier index, crop and duration is unchanged. Both are once tags: 70, 90,
110, 170 ms. Frames 0–2 brake: the leading foot is planted ahead on the
baseline, the 3/4 head leans 2–3 px back against the motion, the sprout swings
from upright to thrown forward and dips, and a small dust puff (`B`/`b`) kicks up
ahead of the heel and thins. Frame 3 recovers to a standing 3/4 pose with the
sprout upright, ready for `idle`. They follow a `run_*` (or a fast sideways
drag); the clankie.bot desk pet slides the sprite over the braking frames.
`skid_left` mirrors `skid_right` with the stem re-lit as in `run_left`. No face
overlay applies to them.

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
