# Clankie's character

Clankie appears in more than one body: the logo, the app's world (the garden
sprites in `clankie-app`), and the desktop pet (sources in `branding/pet/`).
Each body has its own pipeline and canvas, because each is drawn at a different
size for a different job. This page is the one model they all follow, so a
refinement in one body doesn't drift away from the others.

## The reference

The master is `clankie-logo-512-alpha.png`: a 22×28 grid at 12 px a cell. When
two bodies disagree about a shape, the logo wins. A body may simplify the logo
for its size, but it may not restyle it.

| Body        | Canvas                     | Seen at               | Views             |
| ----------- | -------------------------- | --------------------- | ----------------- |
| Logo        | 22×28                      | Any, integer scale    | Front             |
| Desktop pet | 32×40 cell, 22-wide figure | 2×–6×, up close       | Front             |
| World       | 24×28                      | Small, among stations | Front, side, back |
| Subagent    | 11×15 (world sproutling)   | Beside its parent     | Front             |

## Anatomy

From top to bottom, every body keeps these parts in this order:

1. **Sprout.** A stem with two leaves, light on top and dark underneath. It's
   wider than the head and is his main expressive part.
2. **Head.** It's a screen: a cream bezel, a brown inset line, and a cream face.
   The eyes are dark and set wide, and the pink cheeks sit just below them.
   When the eyes are a single pixel, put each cheek down and out from its
   eye, never straight under it, or it reads as a tear.
   Leaving out the bezel turns him into a brown box. The old sproutling did
   that.
3. **Suit.** A khaki torso with a small leaf emblem on the chest, shaded at the
   bottom.
4. **Feet.** Short and stubby, on one fixed baseline per body.

## Palette

Every body uses these exact hex values. A new colour is allowed only for a prop
or effect, and the body that adds it lists it in its own README.

| Role       | Hex       | Role       | Hex       |
| ---------- | --------- | ---------- | --------- |
| leaf light | `#c6d668` | face       | `#f2e5c8` |
| leaf dark  | `#7d8f41` | face shade | `#e3d3ae` |
| stem       | `#6f5f36` | eyes       | `#262f3a` |
| frame      | `#806440` | cheeks     | `#f3b2a4` |
| outline    | `#503b2c` | body       | `#dfddb6` |
|            |           | body shade | `#b2ae7e` |

Each worker is identified by the colour of its leaves, never by tinting its
body. Both bodies use the same variants:

| Variant         | Light     | Dark                                       |
| --------------- | --------- | ------------------------------------------ |
| green (Clankie) | `#c6d668` | `#7d8f41`                                  |
| teal            | `#63d0bd` | `#34988c`                                  |
| amber           | `#f0b24a` | `#c47a2c`                                  |
| dusk            | `#b79ce2` | `#7d5cb0`                                  |
| azure           | `#8fc9ff` | `#4a73b8`                                  |
| gold            | `#f0d696` | `#c9a34e`                                  |
| onyx            | `#9da7b1` | `#2c3138` (plus a full charcoal body ramp) |

## The sprout says how he is

His face stays simple, so the sprout carries his mood. Every body uses the same
motion for the same state:

| Motion                       | Means                 |
| ---------------------------- | --------------------- |
| Small sway, rare 1 px fidget | Idle, fine            |
| Spins like a propeller       | Thinking or working   |
| Perks straight up            | Needs you             |
| Soft half-mast droop         | Asleep                |
| Hooked over, leaves slumped  | Failed (world `wilt`) |

Asleep, he also sits and his screen dims, with flat `-.-` eyes. The screen
never goes dark: a dark screen means unreachable (the pet's `offline`), and the
two must never be confused.

The propeller spin is his signature. It started in the pet's `think` loop, and
the world's sproutlings use it too. Keep it wherever he or a worker is busy.

## Subagents

A subagent is a smaller Clankie, not some other creature. It has the full
anatomy: the sprout, the bezel head with eyes and cheeks, the suit with its
chest leaf, and feet. It's about half his height. Its loop is a rest, a sway,
then a quick double spin of the sprout. The world's sproutling
(`scripts/garden-sprites/channelkit.mjs` in `clankie-app`) is the reference at
11×15. The pet's worker minis follow the same design at pet scale. They show
which worker they are by leaf colour, as above, not through a tinted torso.

## Reviewing a pass

A pass on one body isn't finished until its matching animations sit next to the
other body's, at the same apparent size, on both a light and a dark background.
Look for drift in the proportions and the sprout's motion vocabulary, and check
that each loop runs without a pop. These animations should match: idle, blink,
walk, sleep, talk, celebrate/happy, and think/work.

Known drift as of 2026-10-04:

- The world's figure matches the logo closely. The pet's head is wider and sits
  lower on a shorter suit, so it reads as a different build. This is the
  biggest gap.
- The pet minis tint a magenta torso mask instead of using leaf variants.
- The pet has only a front view, so it has no side or back walk to compare.
