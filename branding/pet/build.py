"""Build the Clankie desktop-pet sheets from the text pixel grids in src/.

    uv run --with pillow python3 branding/pet/build.py

Reads src/palette.txt and every src/<sheet>/<tag>.txt, then writes:
  clankie-pet.png / .json    main sheet, 1x, Aseprite array JSON
  clankie-mini.png / .json   worker-mini sheet, same format
  preview/<tag>.gif          6x nearest-neighbour loop per tag
  preview/contact-sheet.png  every frame, labelled, with baseline/center guides
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
PREVIEW = ROOT / "preview"

# Sheet layout: tag order is frame order in the PNG and JSON.
SHEETS = {
    "clankie-pet": {
        "dir": "pet",
        "cell": (32, 40),
        "baseline": 39,  # first empty row under his feet
        "tags": [
            "idle", "blink", "look_left", "look_right", "walk_left", "walk_right",
            "hop", "fall_asleep", "sleep", "wake", "think", "talk", "play",
            "alert", "happy", "catch", "offline",
        ],
    },
    "clankie-mini": {
        "dir": "mini",
        "cell": (12, 14),
        "baseline": 14,
        "tags": ["mini_idle", "mini_walk"],
    },
}

GIF_SCALE = 6
CONTACT_SCALE = 4
PREVIEW_BG = (236, 232, 222, 255)


def load_palette() -> dict[str, tuple[int, int, int, int]]:
    palette = {".": (0, 0, 0, 0)}
    for line in (SRC / "palette.txt").read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, h = line.split()[:2]
        h = h.lstrip("#")
        palette[key] = (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255)
    return palette


def parse_tag(path: Path, cell: tuple[int, int]):
    """Parse one animation file into (meta, [(duration, rows)])."""
    w, h = cell
    meta = {"direction": "forward", "repeat": None}
    frames: list[tuple[int, list[str]]] = []
    current: list[str] | None = None
    duration = 0
    lineno = 0

    def close():
        if current is None:
            return
        if len(current) != h:
            sys.exit(f"{path.name}: frame {len(frames)} has {len(current)} rows, want {h}")
        frames.append((duration, current))

    for lineno, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.rstrip()
        if line.startswith("#") or (not line and current is None):
            continue
        words = line.split()
        if words and words[0] == "direction":
            meta["direction"] = words[1]
        elif words and words[0] == "repeat":
            meta["repeat"] = words[1]
        elif words and words[0] == "frame":
            close()
            duration = int(words[1])
            current = []
        elif not line:
            continue
        else:
            if current is None:
                sys.exit(f"{path.name}:{lineno}: pixel row before any 'frame' line")
            if len(line) != w:
                sys.exit(f"{path.name}:{lineno}: row is {len(line)} wide, want {w}")
            current.append(line)
    close()
    if not frames:
        sys.exit(f"{path.name}: no frames")
    return meta, frames


def render(rows: list[str], palette) -> Image.Image:
    img = Image.new("RGBA", (len(rows[0]), len(rows)))
    px = img.load()
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch not in palette:
                sys.exit(f"unknown palette key {ch!r}")
            px[x, y] = palette[ch]
    return img


def on_bg(img: Image.Image, scale: int) -> Image.Image:
    big = img.resize((img.width * scale, img.height * scale), Image.NEAREST)
    bg = Image.new("RGBA", big.size, PREVIEW_BG)
    bg.alpha_composite(big)
    return bg


def save_gif(path: Path, frames: list[tuple[int, Image.Image]]):
    imgs = [on_bg(img, GIF_SCALE).convert("RGB") for _, img in frames]
    durations = [d for d, _ in frames]
    if len(imgs) == 1:
        imgs[0].save(path)
        return
    imgs[0].save(
        path, save_all=True, append_images=imgs[1:], duration=durations, loop=0,
        disposal=1, optimize=False,
    )


def build_sheet(name: str, spec: dict, palette) -> list[tuple[str, list[tuple[int, Image.Image]]]]:
    w, h = spec["cell"]
    tags = []
    for tag in spec["tags"]:
        path = SRC / spec["dir"] / f"{tag}.txt"
        meta, frames = parse_tag(path, (w, h))
        tags.append((tag, meta, [(d, render(rows, palette)) for d, rows in frames]))

    total = sum(len(f) for _, _, f in tags)
    sheet = Image.new("RGBA", (w * total, h))
    frames_json = []
    tags_json = []
    i = 0
    for tag, meta, frames in tags:
        start = i
        for duration, img in frames:
            sheet.paste(img, (i * w, 0))
            frames_json.append({
                "filename": f"{name} {i}.aseprite",
                "frame": {"x": i * w, "y": 0, "w": w, "h": h},
                "rotated": False,
                "trimmed": False,
                "spriteSourceSize": {"x": 0, "y": 0, "w": w, "h": h},
                "sourceSize": {"w": w, "h": h},
                "duration": duration,
            })
            i += 1
        tag_json = {"name": tag, "from": start, "to": i - 1, "direction": meta["direction"],
                    "color": "#000000ff"}
        if meta["repeat"]:
            tag_json["repeat"] = meta["repeat"]
        tags_json.append(tag_json)

    sheet.save(ROOT / f"{name}.png")
    doc = {
        "frames": frames_json,
        "meta": {
            "app": "branding/pet/build.py",
            "version": "1",
            "image": f"{name}.png",
            "format": "RGBA8888",
            "size": {"w": sheet.width, "h": sheet.height},
            "scale": "1",
            "frameTags": tags_json,
            "layers": [{"name": "Layer", "opacity": 255, "blendMode": "normal"}],
            "slices": [],
        },
    }
    (ROOT / f"{name}.json").write_text(json.dumps(doc, indent=1) + "\n")

    for tag, _meta, frames in tags:
        save_gif(PREVIEW / f"{tag}.gif", frames)
    return [(tag, frames) for tag, _m, frames in tags], spec


def contact_sheet(groups):
    try:
        font = ImageFont.load_default(size=18)
        small = ImageFont.load_default(size=13)
    except TypeError:
        font = small = ImageFont.load_default()
    s = CONTACT_SCALE
    pad = 12
    label_h = 26
    rows = []
    for (tags, spec) in groups:
        w, h = spec["cell"]
        for tag, frames in tags:
            rows.append((tag, frames, w, h, spec["baseline"]))
    cols = 2
    per_col = (len(rows) + cols - 1) // cols
    max_frames = max(len(f) for _, f, *_ in rows)
    col_w = pad + max_frames * (32 * s + pad)
    row_h = label_h + 40 * s + 18 + pad
    out = Image.new("RGBA", (col_w * cols + pad, per_col * row_h + pad), (250, 248, 243, 255))
    d = ImageDraw.Draw(out)
    for idx, (tag, frames, w, h, baseline) in enumerate(rows):
        cx = pad + (idx // per_col) * col_w
        cy = pad + (idx % per_col) * row_h
        total = sum(dur for dur, _ in frames)
        d.text((cx, cy), f"{tag}  ({len(frames)} fr, {total} ms)", fill=(60, 50, 40, 255), font=font)
        for j, (dur, img) in enumerate(frames):
            fx = cx + j * (32 * s + pad)
            fy = cy + label_h
            tile = Image.new("RGBA", (w * s, h * s), PREVIEW_BG)
            gd = ImageDraw.Draw(tile)
            # guides: horizontal center and foot baseline
            gd.line([(w * s // 2, 0), (w * s // 2, h * s)], fill=(120, 170, 220, 255))
            gd.line([(0, baseline * s), (w * s, baseline * s)], fill=(220, 120, 120, 255))
            sprite = img.resize((w * s, h * s), Image.NEAREST)
            tile.alpha_composite(sprite)
            out.alpha_composite(tile, (fx, fy))
            d.text((fx, fy + h * s + 2), f"{j}: {dur}ms", fill=(110, 100, 90, 255), font=small)
    out.save(PREVIEW / "contact-sheet.png")


def main():
    PREVIEW.mkdir(exist_ok=True)
    palette = load_palette()
    groups = []
    for name, spec in SHEETS.items():
        groups.append(build_sheet(name, spec, palette))
    contact_sheet(groups)
    n = sum(len(f) for tags, _ in groups for _, f in tags)
    print(f"built {n} frames into {', '.join(SHEETS)}; previews in {PREVIEW.relative_to(ROOT.parent.parent)}")


if __name__ == "__main__":
    main()
