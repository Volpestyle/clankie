#!/usr/bin/env python3
"""Generate a pixel-mcp call program that regenerates the garden assets.

Character grids, palettes, and animation timing live in frames.py (the source
of truth); props and the scene layout live here. Output is deterministic —
regenerated files are byte-identical.

Usage:
  gen_program.py [outdir]   -> writes <outdir>/program.json, prints its path
                               (outdir defaults to assets/garden, this script's parent)
Then execute it against the pixel-mcp server:
  mcp_drive.py run <outdir>/program.json
"""
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(__file__))
import frames as fr

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1
                      else os.path.join(os.path.dirname(__file__), ".."))

MUSHROOM = ("""\
...........
.AAAAA.....
AAABAAA....
AAAABAAAAA.
CCCCCCCABBA
.ADDEA.CCC.
..DDE..DDE.
..DDE..DDE.
..EDE..EDE.
...........""", {"A": "#806440", "B": "#f2e5c8", "C": "#57422e",
                  "D": "#dfddb6", "E": "#b2ae7e"})

GRASS = ("""\
..A..
..A..
..A..
BBA..
B.A..
..ABB
..A.B
.BA..
BBA..
..A..
..A..
.....""", {"A": "#6f5f36", "B": "#7d8f41"})

ROCKS = ("""\
...............
........A......
......BABBC....
........D......
...AAAAAB......
...BBBBBBC.....
....DDDDD......
...AAAAAAABB...
..BDBBBBBBBDB..
...DDDDDDDDD...
EEFFFFFFFFFFFEE
...EEEEEEEEE...""", {"A": "#8a8b80", "B": "#6e6f66", "C": "#503b2c",
                      "D": "#57422e", "E": "#295049", "F": "#3c7d72"})

SPRIG = ("""\
..A..
.ABA.
ACBAA
.ADA.
..D..
AAD..
..DA.
..D..
..D..
.....""", {"A": "#7d8f41", "B": "#c68a3a", "C": "#9c6b2c", "D": "#6f5f36"})

Z_GLYPH = """\
ZZZ
.Z.
ZZZ"""


def grid_pixels(grid, colors, ox=0, oy=0):
    rows = grid.splitlines() if isinstance(grid, str) else grid
    px = []
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch != ".":
                px.append({"x": x + ox, "y": y + oy, "color": colors[ch]})
    return px


prog = []


def call(tool, **args):
    prog.append({"tool": tool, "args": args})


def new_sprite(w, h, path):
    prog.append({"tool": "create_canvas",
                 "args": {"width": w, "height": h, "color_mode": "rgb"},
                 "capture": "c"})
    call("save_as", sprite_path="$c", output_path=path)
    return path


def draw(path, pixels, layer="Layer 1", frame=1):
    call("draw_pixels", sprite_path=path, layer_name=layer,
         frame_number=frame, pixels=pixels)


def preview(src, name, factor):
    p = f"{OUT}/{name}-x{factor}.aseprite"
    call("save_as", sprite_path=src, output_path=p)
    call("scale_sprite", sprite_path=p, scale_x=factor, scale_y=factor,
         algorithm="nearest")
    call("export_sprite", sprite_path=p, output_path=f"{OUT}/{name}-x{factor}.png",
         format="png", frame_number=1)


# ---- clankie characters: every animation as a tagged frame range ------------
for variant in fr.LEAF:
    cols = fr.colors(variant)
    p = new_sprite(fr.W, fr.H, f"{OUT}/clankie-{variant}.aseprite")
    fnum = 0
    for anim, seq in fr.ANIMS.items():
        start = fnum + 1
        for frame, dur in seq:
            fnum += 1
            if fnum > 1:
                call("add_frame", sprite_path=p, duration_ms=dur)
            draw(p, grid_pixels(fr.FRAMES[frame], cols), frame=fnum)
            call("set_frame_duration", sprite_path=p, frame_number=fnum, duration_ms=dur)
        call("create_tag", sprite_path=p, tag_name=anim,
             from_frame=start, to_frame=fnum, direction="forward")
    call("export_sprite", sprite_path=p, output_path=f"{OUT}/clankie-{variant}.png",
         format="png", frame_number=1)

    # idle-cycle gif (the tracked at-a-glance preview)
    g = new_sprite(fr.W, fr.H, f"{OUT}/clankie-{variant}-idle.aseprite")
    for i, (frame, dur) in enumerate(fr.ANIMS["idle"]):
        fnum = i + 1
        if fnum > 1:
            call("add_frame", sprite_path=g, duration_ms=dur)
        draw(g, grid_pixels(fr.FRAMES[frame], cols), frame=fnum)
        call("set_frame_duration", sprite_path=g, frame_number=fnum, duration_ms=dur)
    call("export_sprite", sprite_path=g, output_path=f"{OUT}/clankie-{variant}.gif",
         format="gif", frame_number=0)

# ---- props -------------------------------------------------------------------
PROPS = {"mushroom": MUSHROOM, "grass": GRASS, "rocks": ROCKS, "sprig": SPRIG}
for name, (grid, cols) in PROPS.items():
    rows = grid.splitlines()
    p = new_sprite(len(rows[0]), len(rows), f"{OUT}/prop-{name}.aseprite")
    draw(p, grid_pixels(grid, cols))
    call("export_sprite", sprite_path=p, output_path=f"{OUT}/prop-{name}.png",
         format="png", frame_number=1)

# ---- garden scene --------------------------------------------------------------
scene = new_sprite(160, 90, f"{OUT}/garden-scene.aseprite")
call("draw_rectangle", sprite_path=scene, layer_name="Layer 1", frame_number=1,
     x=0, y=0, width=160, height=90, color=fr.BACKGROUND, filled=True)
random.seed(7)
dust = [{"x": random.randrange(2, 158), "y": random.randrange(2, 88),
         "color": "#39414b"} for _ in range(40)]
draw(scene, dust)

call("add_layer", sprite_path=scene, layer_name="props")
props_px = []
props_px += grid_pixels(ROCKS[0], ROCKS[1], 10, 64)
props_px += grid_pixels(MUSHROOM[0], MUSHROOM[1], 52, 14)
props_px += grid_pixels(MUSHROOM[0], MUSHROOM[1], 118, 62)
props_px += grid_pixels(GRASS[0], GRASS[1], 34, 66)
props_px += grid_pixels(GRASS[0], GRASS[1], 98, 12)
props_px += grid_pixels(GRASS[0], GRASS[1], 144, 70)
props_px += grid_pixels(SPRIG[0], SPRIG[1], 78, 46)
props_px += grid_pixels(SPRIG[0], SPRIG[1], 6, 24)
draw(scene, props_px, layer="props")

call("add_layer", sprite_path=scene, layer_name="clankies")
crew_px = []
crew_px += grid_pixels(fr.IDLE0, fr.colors("green"), 29, 28)
crew_px += grid_pixels(fr.IDLE0, fr.colors("teal"), 63, 40)
crew_px += grid_pixels(fr.IDLE0, fr.colors("amber"), 95, 24)
crew_px += grid_pixels(fr.IDLE0, fr.colors("purple"), 53, 60)
# sleeper: the soft-droop sleeping pose, Zs above
crew_px += grid_pixels(fr.SLEEP0, fr.colors("green"), 121, 16)
crew_px += grid_pixels(Z_GLYPH, {"Z": "#f2e5c8"}, 142, 10)
crew_px += grid_pixels(Z_GLYPH, {"Z": "#f2e5c8"}, 147, 4)
draw(scene, crew_px, layer="clankies")

call("export_sprite", sprite_path=scene, output_path=f"{OUT}/garden-scene.png",
     format="png", frame_number=1)

# ---- big previews (nearest-neighbor upscales for eyeballing) -------------------
for variant in fr.LEAF:
    preview(f"{OUT}/clankie-{variant}.aseprite", f"clankie-{variant}", 8)
preview(scene, "garden-scene", 5)

path = f"{OUT}/program.json"
with open(path, "w") as f:
    json.dump(prog, f)
print(path)
