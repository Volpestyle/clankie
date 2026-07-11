"""Clankie garden sprite grids — the importable source of truth for character art.

Each frame is a list of 24-char strings (24x28 canvas), one char per pixel,
keyed to BASE/LEAF palettes ('.' = transparent). validate() runs at import and
fails loudly with frame name + row on any width or palette-key error.

Geometry contract (front pose): rows 0-7 sprout crown+stem, 8-19 head,
20-24 torso/arms, 25-27 legs/feet/soles. This is the canonical 24x28 canvas of
the clankies pipeline (frames.mjs), so grids port 1:1 into the VUH-708 pipeline.

Directional scheme (VUH-753, 3-pose/4-way): front = down, back = up, side is
authored FACING RIGHT (runtime mirrors for left — keep side frames free of
asymmetries that read wrong mirrored). Stationary states stay front-facing.

Authoring model: distinct poses are hand-written literals; everything else is
derived (mirror, bob_up, sink, crown sway) so cycles stay consistent when a
base pose changes.
"""

# ---- palettes ---------------------------------------------------------------
BASE = {
    "F": "#f2e5c8",  # cream face
    "O": "#503b2c",  # dark outline
    "B": "#806440",  # bezel / stem brown
    "K": "#dfddb6",  # khaki body
    "D": "#b2ae7e",  # khaki shade
    "C": "#e3d3ae",  # cream shade
    "E": "#262f3a",  # eyes
    "P": "#f3b2a4",  # pink cheeks
    "S": "#6f5f36",  # dark olive stem
    "W": "#e8ece4",  # cloud / dust
    "V": "#b9c0b4",  # cloud / dust shade
}
LEAF = {
    "green":  ("#c6d668", "#7d8f41"),
    "amber":  ("#f0b24a", "#c47a2c"),
    "teal":   ("#63d0bd", "#34988c"),
    "purple": ("#b79ce2", "#7d5cb0"),
}
BACKGROUND = "#242a2e"  # slate the garden renders on

W, H = 24, 28


# ---- helpers ----------------------------------------------------------------
def rows(s):
    return s.splitlines()


def with_rows(grid, overrides):
    g = list(grid)
    for i, row in overrides.items():
        g[i] = row
    return g


def mirror(grid):
    return [r[::-1] for r in grid]


def shift_row(row, dx):
    if dx > 0:
        return ("." * dx + row)[:W]
    if dx < 0:
        return (row[-dx:] + "." * -dx)
    return row


def sway(grid, first, last, dx):
    """Shift rows first..last horizontally by dx (crown follow-through)."""
    return [shift_row(r, dx) if first <= i <= last else r for i, r in enumerate(grid)]


def bob_up(grid, legs):
    """Body rises 1px, feet stay planted (legs stretch): passing frames."""
    return grid[1:25] + [legs[25], legs[25], legs[26], legs[27]]


def sink(grid, legs=None):
    """Body sags 1px into the ground, feet stay planted (impact / breath)."""
    legs = legs or grid
    return [BLANK] + grid[:24] + [legs[25], legs[26], legs[27]]


def overlay(grid, pixels):
    """Set individual (col,row,char) pixels on a copy of the grid."""
    g = [list(r) for r in grid]
    for x, y, ch in pixels:
        g[y][x] = ch
    return ["".join(r) for r in g]


BLANK = "." * W


# ---- FRONT: base poses (ported 1:1 from clankies frames.mjs) ---------------
IDLE0 = rows("""\
..............LLLLLLL...
..LLLLLL....GLLLLLLLLG..
.LLLLLLLG..SGLLLLLLLLLG.
.GLLLLLGGGBSGGGGGGGG....
..GGG.....BSSGG.........
..........BSS...........
..........BSS...........
.........SBBS...........
.....OOOOOOSSOOOOOO.....
....OFFFFFFFFFFFFFFO....
...OFFFFFFFFFFFFFFFFO...
...OFBBBBBBBBBBBBBBFO...
...OFBFFFFFFFFFFFFBFO...
...OFBFFFFFFFFFFFFBFO...
...OFBFFEEFFFFEEFFBFO...
...OFBFFEEFFFFEEFFBFO...
...OFBFPPFFFFFFPPFBFO...
...OFBBBBBBBBBBBBBBFO...
....OFFCCCCCCCCCCFFO....
.....OOOOOOOOOOOOOO.....
........OOOOOOOO........
.......OKKKLLKKKO.......
.....OKOKKLGGLKKOKO.....
.....OKOKKKLLKKKOKO.....
.....OODDDDDDDDDDOO.....
.......OKKO..OKKO.......
.......ODDO..ODDO.......
.......OOOO..OOOO.......""")

WALK0 = with_rows(IDLE0, {
    25: "......OKKO....ODDO......",  # L leg forward+planted, R foot raised
    26: "......ODDO....OOOO......",
    27: "......OOOO..............",
})

WORK0 = IDLE0[:19] + rows("""\
...OOOOOOOOOOOOOOOO.....
...OKO..OOOOOOOO........
...OKO.KKKLLKKKO........
......OKKLGGLKKOKO......
......OKKKLLKKKOKO......
.......ODDDDDDDDOO......
.......OKKO..OKKO.......
.......ODDO..ODDO.......
.......OOOO..OOOO.......""")

# carry: a broad frond hugged against the chest — crown and head stay exactly
# idle's (his leaf is his identity), the cargo leaf is wider than the torso
# with the hands wrapped visibly over its sides, and it covers the chest
# clover: a big silhouette change from idle that reads at native scale.
CARRY0 = IDLE0[:21] + rows("""\
.......OKKKKKKKKO.......
...GLLLLLLLLLLLLLLLLG...
...OKKOLLLLLLLLLLOKKO...
....GGGGGGGGGGGGGGGG....
.......OKKO..OKKO.......
.......ODDO..ODDO.......
.......OOOO..OOOO.......""")

BLOCKED0 = IDLE0[:19] + rows("""\
...OOOOOOOOOOOOOOOOOO...
...OKO..OOOOOOOO..OKO...
...OKO.KKKKLLKKKK.OKO...
.......OKKLGGLKKO.......
.......OKKKLLKKKO.......
.......ODDDDDDDDO.......
.......OKKO..OKKO.......
.......ODDO..ODDO.......
.......OOOO..OOOO.......""")

# wilt: the stem stays rooted but hooks over at the top, and the leaves hang
# limp down the head's right side (a small dead nub flops left) — losing
# turgor, not flipping upside down. Head lolls right with low eyes.
WILT0 = rows("""\
........................
........................
........................
........................
........................
..........BSS...........
..........BSSG..........
......GG.SBBSGLLLG......
....GGOOOOOOSSOGLLLLG...
.....OFFFFFFFFFFFFFFOGLG
....OFFFFFFFFFFFFFFFFOG.
....OFBBBBBBBBBBBBBBFOG.
....OFBFFFFFFFFFFFFBFO..
....OFBFFFFFFFFFFFFBFO..
....OFBFFFFFFFFFFFFBFO..
....OFBFFEEFFFFEEFFBFO..
....OFBFPPFFFFFFPPFBFO..
....OFBBBBBBBBBBBBBBFO..
.....OFFCCCCCCCCCCFFO...
......OOOOOOOOOOOOOO....
........OOOOOOOO........
.......OKKKLLKKKO.......
.....OKOKKLGGLKKOKO.....
.....OKOKKKLLKKKOKO.....
.....OODDDDDDDDDDOO.....
.......OKKO..OKKO.......
.......ODDO..ODDO.......
.......OOOO..OOOO.......""")

FACE_PLAIN = IDLE0[12]  # eyes-open row -> plain face (blink / closed lids)

# ---- FRONT: derived + improved frames ---------------------------------------
# idle: blink + a rare 1px crown sway so he reads alive between blinks.
IDLE1 = with_rows(IDLE0, {14: FACE_PLAIN})
IDLE_SWAY = sway(IDLE0, 0, 4, -1)

# walk: contact frames alternate legs; passing frames bob up with the crown
# lagging opposite ways (follow-through), so the waddle springs.
WALK2 = mirror(WALK0)
WALK1 = sway(bob_up(IDLE0, IDLE0), 0, 3, -1)
WALK3 = sway(bob_up(IDLE0, IDLE0), 0, 3, 1)

# work: 4-beat dig — wind-up (arm raised), fast swing, impact (squash + dust),
# recover (plain stand, reused idle0 in the cycle).
WORK_SWING = with_rows(IDLE0, {
    20: "...OKO..OOOOOOOO........",  # hand out at shoulder height
    21: ".....OKOKKKLLKKKO.......",  # forearm steps diagonally into the shoulder
    22: ".......OKKLGGLKKOKO.....",
    23: ".......OKKKLLKKKOKO.....",
    24: ".......ODDDDDDDDDOO.....",
})
WORK_IMPACT = overlay(sink(IDLE0), [
    (4, 25, "W"), (3, 26, "W"), (4, 26, "V"), (3, 27, "V"),
    (19, 25, "W"), (20, 26, "W"), (19, 26, "V"), (20, 27, "V"),
])

# carry heave beat: body and load lift 1px together (feet planted), then
# settle 1px into the ground — weight, not levitation.
CARRY_LIFT = bob_up(CARRY0, CARRY0)
CARRY_SETTLE = sink(CARRY0)

# blocked: hands up, worried — second frame glances the eyes 1px left.
GLANCE_L = "...OFBFEEFFFFEEFFFBFO..."
BLOCKED1 = with_rows(BLOCKED0, {14: GLANCE_L, 15: GLANCE_L})

# sleep: its own pose — crown at soft half-mast (wilt stays "fully flopped =
# failed"), half-lidded eyes, 3-phase breath (settle / sag / deep sag).
SLEEP_CROWN = rows("""\
........................
........................
..........BSS...........
..LLLLLL.GBSSG.LLLLLL...
.GLLLLLLGGBSSGGLLLLLLG..
..GLLLLG..BSS..GLLLLG...
...GGG....BSS....GGG....
.........SBBS...........""")
SLEEP0 = SLEEP_CROWN + with_rows(IDLE0, {14: FACE_PLAIN})[8:]
SLEEP1 = sink(SLEEP0)
SLEEP2 = with_rows(SLEEP1, {3: BLANK, 4: SLEEP1[3], 5: SLEEP1[4], 6: SLEEP1[5]})

WILT1 = sink(WILT0)


# ---- poof: dust-cloud disappearance (procedural, ported) ---------------------
def _canvas(w, h):
    return [["."] * w for _ in range(h)]


def _ellipse(c, cx, cy, rx, ry, ch):
    for y in range(len(c)):
        for x in range(len(c[0])):
            dx, dy = (x - cx) / rx, (y - cy) / ry
            if dx * dx + dy * dy <= 1:
                c[y][x] = ch


def _poof(kind):
    c = _canvas(W, H)

    def puff(cx, cy, rx, ry):
        _ellipse(c, cx, cy + 1, rx, ry, "V")
        _ellipse(c, cx, cy, rx, ry, "W")

    if kind == 0:
        puff(12, 19, 5, 4); puff(8, 21, 3, 3); puff(16, 21, 3, 3)
    elif kind == 1:
        puff(12, 15, 8, 6); puff(6, 18, 4, 4); puff(18, 18, 4, 4)
        puff(12, 21, 6, 4); puff(10, 11, 3, 3); puff(15, 11, 3, 3)
    else:
        puff(6, 9, 3, 3); puff(18, 11, 3, 2); puff(3, 17, 2, 2)
        puff(21, 16, 2, 2); puff(12, 7, 2, 2); puff(13, 21, 3, 2); puff(8, 22, 2, 2)
    return ["".join(r) for r in c]


POOF0, POOF1, POOF2 = _poof(0), _poof(1), _poof(2)


# ---- SIDE pose set (authored facing right; runtime mirrors for left) --------
# 3/4 cheat: the head keeps the front bezel language but 5px narrower, with one
# 2x2 eye pushed to the leading edge and the cheek forward — reads "same guy,
# looking right". Crown stays the iconic front sprout (stem lines up at 11-12).
SIDE_IDLE0 = IDLE0[:8] + rows("""\
.......OOOOSSOOOOOOO....
.......OFFFFFFFFFFFO....
......OFFFFFFFFFFFFFO...
......OFBBBBBBBBBBBFO...
......OFBFFFFFFFFFBFO...
......OFBFFFFFFFFFBFO...
......OFBFFFFFEEFFBFO...
......OFBFFFFFEEFFBFO...
......OFBFFFPPFFFFBFO...
......OFBBBBBBBBBBBFO...
......OFCCCCCCCCFFFO....
.......OOOOOOOOOOOOO....
..........OOOOOOO.......
.........OKKKKKLGO......
.........OKKKKKKOKO.....
.........OKKKKKKOKO.....
.........ODDDDDDDOO.....
..........ODKKO.........
..........ODDDDO........
..........OOOOOO........""")

SIDE_WALK0 = with_rows(SIDE_IDLE0, {   # contact A: near leg forward
    25: "........ODO..OKKO.......",
    26: "........ODO..ODDO.......",
    27: ".........O....OOOO......",
})
SIDE_WALK2 = with_rows(SIDE_IDLE0, {   # contact B: near leg back
    25: "........OKKO..ODO.......",
    26: "........ODDO..ODO.......",
    27: "........OOOO...O........",
})
SIDE_WALK1 = sway(bob_up(SIDE_IDLE0, SIDE_IDLE0), 0, 3, 1)   # lean into the step
SIDE_WALK3 = sway(bob_up(SIDE_IDLE0, SIDE_IDLE0), 0, 3, -1)  # crown lags back

# side carry: the frond juts forward from the chest, seen edge-on; the near
# arm wraps visibly over it. Crown and head stay idle's.
SIDE_CARRY0 = SIDE_IDLE0[:21] + rows("""\
.........OKKKKGLLLLG....
.........OKKKKGOKKOLG...
.........OKKKKGLLLLLG...
.........ODDDDGGGGGG....
..........ODKKO.........
..........ODDDDO........
..........OOOOOO........""")

SIDE_CARRY_LIFT = bob_up(SIDE_CARRY0, SIDE_CARRY0)
SIDE_CARRY_SETTLE = sink(SIDE_CARRY0)

# ---- BACK pose set -----------------------------------------------------------
# Plain panel back (no face) with a tiny leaf sticker, mirrored crown, no chest
# clover on the suit back. Legs cycle reads the same from behind.
BACK_FACE_PLAIN = "...OFBFFFFFFFFFFFFBFO..."
BACK_HEAD = with_rows(IDLE0, {
    12: BACK_FACE_PLAIN, 13: BACK_FACE_PLAIN,
    14: "...OFBFFFFFFFFLGFFBFO...",  # 2x2 leaf sticker on the panel back
    15: "...OFBFFFFFFFFGLFFBFO...",
    16: BACK_FACE_PLAIN,
})
BACK_IDLE0 = mirror(IDLE0[:8]) + BACK_HEAD[8:20] + rows("""\
........OOOOOOOO........
.......OKKKKKKKKO.......
.....OKOKKKKKKKKOKO.....
.....OKOKKKKKKKKOKO.....
.....OODDDDDDDDDDOO.....
.......OKKO..OKKO.......
.......ODDO..ODDO.......
.......OOOO..OOOO.......""")

BACK_WALK0 = with_rows(BACK_IDLE0, {25: WALK0[25], 26: WALK0[26], 27: WALK0[27]})
BACK_WALK2 = with_rows(BACK_IDLE0, {25: WALK2[25], 26: WALK2[26], 27: WALK2[27]})
BACK_WALK1 = sway(bob_up(BACK_IDLE0, BACK_IDLE0), 0, 3, 1)
BACK_WALK3 = sway(bob_up(BACK_IDLE0, BACK_IDLE0), 0, 3, -1)

# back carry: the frond is in front of the body, so from behind only its tips
# peek past the torso sides; the arms wrap forward out of sight.
BACK_CARRY0 = BACK_IDLE0[:21] + rows("""\
....GLLOKKKKKKKKOLLG....
....GLLOKKKKKKKKOLLG....
.....GGOKKKKKKKKOGG.....
.......ODDDDDDDDO.......
.......OKKO..OKKO.......
.......ODDO..ODDO.......
.......OOOO..OOOO.......""")

BACK_CARRY_LIFT = bob_up(BACK_CARRY0, BACK_CARRY0)
BACK_CARRY_SETTLE = sink(BACK_CARRY0)


# ---- registry ----------------------------------------------------------------
FRAMES = {
    "idle0": IDLE0, "idle1": IDLE1, "idleSway": IDLE_SWAY,
    "walk0": WALK0, "walk1": WALK1, "walk2": WALK2, "walk3": WALK3,
    "work0": WORK0, "workSwing": WORK_SWING, "workImpact": WORK_IMPACT,
    "carry0": CARRY0, "carryLift": CARRY_LIFT, "carrySettle": CARRY_SETTLE,
    "blocked0": BLOCKED0, "blocked1": BLOCKED1,
    "sleep0": SLEEP0, "sleep1": SLEEP1, "sleep2": SLEEP2,
    "wilt0": WILT0, "wilt1": WILT1,
    "poof0": POOF0, "poof1": POOF1, "poof2": POOF2,
    "sideIdle0": SIDE_IDLE0,
    "sideWalk0": SIDE_WALK0, "sideWalk1": SIDE_WALK1,
    "sideWalk2": SIDE_WALK2, "sideWalk3": SIDE_WALK3,
    "sideCarry0": SIDE_CARRY0, "sideCarryLift": SIDE_CARRY_LIFT, "sideCarrySettle": SIDE_CARRY_SETTLE,
    "backIdle0": BACK_IDLE0,
    "backWalk0": BACK_WALK0, "backWalk1": BACK_WALK1,
    "backWalk2": BACK_WALK2, "backWalk3": BACK_WALK3,
    "backCarry0": BACK_CARRY0, "backCarryLift": BACK_CARRY_LIFT, "backCarrySettle": BACK_CARRY_SETTLE,
}

# name -> [(frame, duration_ms), ...]
ANIMS = {
    "idle": [("idle0", 1600), ("idleSway", 350), ("idle0", 1400), ("idle1", 140)],
    "walk": [("walk0", 150), ("walk1", 150), ("walk2", 150), ("walk3", 150)],
    "work": [("work0", 260), ("workSwing", 100), ("workImpact", 160), ("idle0", 220)],
    "carry": [("carry0", 260), ("carryLift", 160), ("carry0", 260), ("carrySettle", 180)],
    "blocked": [("blocked0", 700), ("blocked1", 700)],
    "sleep": [("sleep0", 950), ("sleep1", 350), ("sleep2", 1150), ("sleep1", 350)],
    "wilt": [("wilt0", 1000), ("wilt1", 1000)],
    "poof": [("poof0", 120), ("poof1", 120), ("poof2", 140)],
    "walk-side": [("sideWalk0", 150), ("sideWalk1", 150), ("sideWalk2", 150), ("sideWalk3", 150)],
    "carry-side": [("sideCarry0", 260), ("sideCarryLift", 160), ("sideCarry0", 260), ("sideCarrySettle", 180)],
    "walk-back": [("backWalk0", 150), ("backWalk1", 150), ("backWalk2", 150), ("backWalk3", 150)],
    "carry-back": [("backCarry0", 260), ("backCarryLift", 160), ("backCarry0", 260), ("backCarrySettle", 180)],
}

# direction groups for the review contact sheet (VUH-753 acceptance)
DIRECTIONS = {
    "front": ["idle", "walk", "work", "carry", "blocked", "sleep", "wilt", "poof"],
    "side": ["walk-side", "carry-side"],
    "back": ["walk-back", "carry-back"],
}


def colors(variant="green"):
    light, dark = LEAF[variant]
    return {**BASE, "L": light, "G": dark}


def validate():
    keys = set(BASE) | {"L", "G"}
    for name, grid in FRAMES.items():
        if len(grid) != H:
            raise ValueError(f"{name}: {len(grid)} rows != {H}")
        for i, row in enumerate(grid):
            if len(row) != W:
                raise ValueError(f"{name} row {i}: width {len(row)} != {W}: {row!r}")
            bad = set(row) - keys - {"."}
            if bad:
                raise ValueError(f"{name} row {i}: unknown keys {bad}")
    for anim, seq in ANIMS.items():
        for frame, _ in seq:
            if frame not in FRAMES:
                raise ValueError(f"anim {anim}: unknown frame {frame}")


validate()
