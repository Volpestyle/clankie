#!/usr/bin/env python3
"""Render review artifacts for garden animations via pixel-mcp (Aseprite).

Usage:
  render_review.py [anim ...]      -> render just those (default: all ANIMS)
  render_review.py --variant teal  -> non-green leaf tint

For each animation, writes into assets/garden/review/ (untracked):
  <anim>-strip.png   frames side by side on the slate bg, x6 nearest
  <anim>.gif         animated at authored per-frame durations, x6

The strip is for pixel inspection, the gif for motion. Iterate on grids in
frames.py and rerun; on sign-off, bake via gen_program.py.
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
import frames as fr

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "review")
SCALE = 6
GAP = 2


def grid_pixels(grid, colors, ox=0, oy=0):
    px = []
    for y, row in enumerate(grid):
        for x, ch in enumerate(row):
            if ch != ".":
                px.append({"x": x + ox, "y": y + oy, "color": colors[ch]})
    return px


def sheet_program(colors):
    """Contact sheet grouped by direction: front / side (+ runtime mirror) / back."""
    bands = [
        [fr.FRAMES[n] for n in [
            "idle0", "idle1", "idleSway", "walk0", "walk1", "walk2", "walk3",
            "work0", "workSwing", "workImpact", "carry0", "carryLift", "carrySettle",
            "blocked0", "blocked1", "sleep0", "sleep1", "sleep2", "wilt0", "wilt1",
            "poof0", "poof1", "poof2"]],
        [fr.FRAMES[n] for n in [
            "sideIdle0", "sideWalk0", "sideWalk1", "sideWalk2", "sideWalk3",
            "sideCarry0", "sideCarryLift", "sideCarrySettle"]] +
        [fr.mirror(fr.FRAMES[n]) for n in [
            "sideIdle0", "sideWalk0", "sideWalk1", "sideWalk2", "sideWalk3",
            "sideCarry0", "sideCarryLift", "sideCarrySettle"]],
        [fr.FRAMES[n] for n in [
            "backIdle0", "backWalk0", "backWalk1", "backWalk2", "backWalk3",
            "backCarry0", "backCarryLift", "backCarrySettle"]],
    ]
    cellw, cellh = fr.W + GAP, fr.H + GAP + 4
    w = max(len(b) for b in bands) * cellw + GAP
    h = len(bands) * cellh + GAP
    prog = []
    call = lambda tool, **a: prog.append({"tool": tool, "args": a})
    path = os.path.join(OUT, "contact-sheet-directions.aseprite")
    prog.append({"tool": "create_canvas",
                 "args": {"width": w, "height": h, "color_mode": "rgb"},
                 "capture": "sheet"})
    call("save_as", sprite_path="$sheet", output_path=path)
    call("draw_rectangle", sprite_path=path, layer_name="Layer 1", frame_number=1,
         x=0, y=0, width=w, height=h, color=fr.BACKGROUND, filled=True)
    px = []
    for r, band in enumerate(bands):
        for i, grid in enumerate(band):
            px += grid_pixels(grid, colors, GAP + i * cellw, GAP + r * cellh)
    call("draw_pixels", sprite_path=path, layer_name="Layer 1", frame_number=1, pixels=px)
    call("scale_sprite", sprite_path=path, scale_x=4, scale_y=4, algorithm="nearest")
    out_png = os.path.join(OUT, "contact-sheet-directions.png")
    call("export_sprite", sprite_path=path, output_path=out_png, format="png", frame_number=1)
    return prog, out_png


def main():
    argv = sys.argv[1:]
    variant = "green"
    if "--variant" in argv:
        i = argv.index("--variant")
        variant = argv[i + 1]
        del argv[i:i + 2]
    mirrored = "--mirror" in argv  # preview the runtime left-facing mirror
    args = [a for a in argv if not a.startswith("--")]
    anims = args or list(fr.ANIMS)
    colors = fr.colors(variant)
    os.makedirs(OUT, exist_ok=True)

    if "--sheet" in sys.argv:
        prog, out_png = sheet_program(colors)
        prog_path = os.path.join(OUT, "review-program.json")
        with open(prog_path, "w") as f:
            json.dump(prog, f)
        r = subprocess.run([sys.executable, os.path.join(HERE, "mcp_drive.py"), "run", prog_path],
                           capture_output=True, text=True)
        if r.returncode != 0:
            print(r.stdout[-2000:], r.stderr[-500:])
            sys.exit(1)
        print(out_png)
        return

    prog = []
    call = lambda tool, **a: prog.append({"tool": tool, "args": a})

    for anim in anims:
        seq = fr.ANIMS[anim]
        grids = {f: (fr.mirror(fr.FRAMES[f]) if mirrored else fr.FRAMES[f]) for f, _ in seq}
        tag = f"{anim}-mirror" if mirrored else anim
        # --- strip: frames side by side on slate ---
        n = len(seq)
        w = n * (fr.W + GAP) + GAP
        h = fr.H + 2 * GAP
        strip = os.path.join(OUT, f"{tag}-strip.aseprite")
        prog.append({"tool": "create_canvas",
                     "args": {"width": w, "height": h, "color_mode": "rgb"},
                     "capture": f"s_{anim}"})
        call("save_as", sprite_path=f"$s_{anim}", output_path=strip)
        call("draw_rectangle", sprite_path=strip, layer_name="Layer 1", frame_number=1,
             x=0, y=0, width=w, height=h, color=fr.BACKGROUND, filled=True)
        px = []
        for i, (frame, _) in enumerate(seq):
            px += grid_pixels(grids[frame], colors, GAP + i * (fr.W + GAP), GAP)
        call("draw_pixels", sprite_path=strip, layer_name="Layer 1", frame_number=1, pixels=px)
        call("scale_sprite", sprite_path=strip, scale_x=SCALE, scale_y=SCALE, algorithm="nearest")
        call("export_sprite", sprite_path=strip, output_path=os.path.join(OUT, f"{tag}-strip.png"),
             format="png", frame_number=1)

        # --- gif: animated at authored durations ---
        gif = os.path.join(OUT, f"{tag}.aseprite")
        prog.append({"tool": "create_canvas",
                     "args": {"width": fr.W + 2 * GAP, "height": fr.H + 2 * GAP, "color_mode": "rgb"},
                     "capture": f"g_{anim}"})
        call("save_as", sprite_path=f"$g_{anim}", output_path=gif)
        for i, (frame, dur) in enumerate(seq):
            fnum = i + 1
            if fnum > 1:
                call("add_frame", sprite_path=gif, duration_ms=dur)
            call("draw_rectangle", sprite_path=gif, layer_name="Layer 1", frame_number=fnum,
                 x=0, y=0, width=fr.W + 2 * GAP, height=fr.H + 2 * GAP,
                 color=fr.BACKGROUND, filled=True)
            call("draw_pixels", sprite_path=gif, layer_name="Layer 1", frame_number=fnum,
                 pixels=grid_pixels(grids[frame], colors, GAP, GAP))
            call("set_frame_duration", sprite_path=gif, frame_number=fnum, duration_ms=dur)
        call("scale_sprite", sprite_path=gif, scale_x=SCALE, scale_y=SCALE, algorithm="nearest")
        call("export_sprite", sprite_path=gif, output_path=os.path.join(OUT, f"{tag}.gif"),
             format="gif", frame_number=0)

    prog_path = os.path.join(OUT, "review-program.json")
    with open(prog_path, "w") as f:
        json.dump(prog, f)
    r = subprocess.run([sys.executable, os.path.join(HERE, "mcp_drive.py"), "run", prog_path],
                       capture_output=True, text=True)
    errs = [l for l in r.stdout.splitlines() if "ERROR" in l]
    if r.returncode != 0 or errs:
        print(r.stdout[-2000:], r.stderr[-500:])
        sys.exit(1)
    suffix = "-mirror" if mirrored else ""
    for anim in anims:
        print(os.path.join(OUT, f"{anim}{suffix}-strip.png"))
        print(os.path.join(OUT, f"{anim}{suffix}.gif"))


if __name__ == "__main__":
    main()
