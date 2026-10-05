"""Verify the real generated art boundary and render an offline review strip.

uv run --with pillow python3 docs/testing/2026-10-05-pet-faces/verify-art.py --baseline 05ccea2e
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import io
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[3]
ART = ROOT / "branding/pet"
OUT = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("pet_build", ART / "build.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


def git_bytes(baseline, path):
    return subprocess.check_output(["git", "show", f"{baseline}:{path}"], cwd=ROOT)


def crop(sheet, frame):
    rect = frame["frame"]
    return sheet.crop((rect["x"], rect["y"], rect["x"] + rect["w"], rect["y"] + rect["h"]))


def verify(baseline):
    old_doc = json.loads(git_bytes(baseline, "branding/pet/clankie-pet.json"))
    doc = json.loads((ART / "clankie-pet.json").read_text())
    old_sheet = Image.open(io.BytesIO(git_bytes(baseline, "branding/pet/clankie-pet.png"))).convert("RGBA")
    sheet = Image.open(ART / "clankie-pet.png").convert("RGBA")
    count = len(old_doc["frames"])
    assert doc["frames"][:count] == old_doc["frames"], "Existing frame indices/crops/durations changed"
    old_tags = old_doc["meta"]["frameTags"]
    assert doc["meta"]["frameTags"][:len(old_tags)] == old_tags, "Existing tags changed"
    prefix = sheet.crop((0, 0, old_sheet.width, old_sheet.height)).tobytes()
    assert prefix == old_sheet.tobytes(), "Existing sprite crop pixels changed"
    source_paths = subprocess.check_output(
        ["git", "ls-tree", "-r", "--name-only", baseline, "branding/pet/src"], cwd=ROOT, text=True,
    ).splitlines()
    for path in source_paths:
        assert (ROOT / path).read_bytes() == git_bytes(baseline, path), f"Existing source changed: {path}"
    for path in ["branding/pet/clankie-mini.png", "branding/pet/clankie-mini.json"]:
        assert (ROOT / path).read_bytes() == git_bytes(baseline, path), f"Mini output changed: {path}"

    tags = {tag["name"]: tag for tag in doc["meta"]["frameTags"]}
    appended = doc["meta"]["frameTags"][len(old_tags):]
    assert [tag["name"] for tag in appended] == list(build.FACE_TAGS), "Faces must be appended in contract order"
    x, y, w, h = build.FACE_SCREEN
    face_frames = {}
    for tag in appended:
        images = [crop(sheet, doc["frames"][index]) for index in range(tag["from"], tag["to"] + 1)]
        face_frames[tag["name"]] = images
        for image in images:
            assert image.size == (32, 40)
            for yy in range(40):
                for xx in range(32):
                    expected = 255 if x <= xx < x + w and y <= yy < y + h else 0
                    assert image.getpixel((xx, yy))[3] == expected, f"Overlay mask mismatch: {tag['name']} {xx},{yy}"
    assert len({images[0].tobytes() for images in face_frames.values()}) == len(build.FACE_TAGS)

    idle = crop(sheet, doc["frames"][tags["idle"]["from"]])
    for name, images in face_frames.items():
        gif = Image.open(ART / "preview" / f"{name}.gif")
        assert gif.n_frames == len(images)
        for index, face in enumerate(images):
            gif.seek(index)
            duration = doc["frames"][tags[name]["from"] + index]["duration"]
            assert gif.info["duration"] == duration
            expected = build.on_bg(Image.alpha_composite(idle, face), build.GIF_SCALE).convert("RGB")
            assert gif.convert("RGB").tobytes() == expected.tobytes(), f"GIF pixels changed: {name}:{index}"

    geometry = json.loads((ART / "face-geometry.json").read_text())
    assert geometry == {
        tag: [{"x": 0, "y": dy} for dy in offsets]
        for tag, offsets in build.FACE_BODY_OFFSETS.items()
    }, "Generated screen geometry is stale"
    compositions = 0
    for name, offsets in geometry.items():
        tag = tags[name]
        assert len(offsets) == tag["to"] - tag["from"] + 1
        for index, offset in enumerate(offsets):
            body = crop(sheet, doc["frames"][tag["from"] + index])
            for images in face_frames.values():
                for face in images:
                    composed = body.copy()
                    composed.alpha_composite(face, (offset["x"], offset["y"]))
                    for yy in range(40):
                        for xx in range(32):
                            if not x <= xx < x + w or not y + offset["y"] <= yy < y + offset["y"] + h:
                                assert composed.getpixel((xx, yy)) == body.getpixel((xx, yy))
                    compositions += 1

    # Exercise the actual builder against malformed source copies, with no
    # mutations to the checked-in art or a mocked rendering implementation.
    rejected = []
    for label, px, py, key in [("outside screen", 0, 0, "e"), ("uncovered background", 10, 23, ".")]:
        with tempfile.TemporaryDirectory(prefix="pet-face-mask-") as temporary:
            target = Path(temporary)
            shutil.copy(ART / "build.py", target / "build.py")
            shutil.copytree(ART / "src", target / "src")
            path = target / "src/pet/face_working.txt"
            lines = path.read_text().splitlines()
            start = next(index for index, line in enumerate(lines) if line.startswith("frame ")) + 1
            row = lines[start + py]
            lines[start + py] = row[:px] + key + row[px + 1:]
            path.write_text("\n".join(lines) + "\n")
            result = subprocess.run([sys.executable, str(target / "build.py")], capture_output=True, text=True)
            assert result.returncode != 0 and "violates the screen mask" in result.stderr
            rejected.append(label)
    evidence = {
        "kind": "offline generated sprite review; not a live app capture",
        "baseline": baseline,
        "preservedFrames": count,
        "preservedSourceFiles": len(source_paths),
        "preservedRgbaSha256": hashlib.sha256(prefix).hexdigest(),
        "miniOutputsByteIdentical": True,
        "screen": {"x": x, "y": y, "w": w, "h": h},
        "opaquePixelsPerOverlay": w * h,
        "appendedTags": appended,
        "validatedCompositions": compositions,
        "gifSequencesVerified": len(face_frames),
        "builderRejected": {label: True for label in rejected},
    }
    return doc, sheet, tags, geometry, evidence


def render_strip(doc, sheet, tags, geometry):
    rows = [
        ("Working", "face_working", "think", [0, 6, 19]),
        ("New message", "face_new_message", "idle", [0, 1, 3]),
        ("Needs you", "face_needs_you", "alert", [0, 1, 2]),
        ("Error", "face_error", "idle", [0, 1, 3]),
        ("Voice", "face_voice", "talk", [0, 1, 2]),
        ("Lead alignment", "face_working", "lead", [0, 1, 2]),
        ("Hop alignment", "face_needs_you", "hop", [0, 1, 2]),
    ]
    scale, pad, label_w, row_h = 5, 24, 200, 250
    tile_w, tile_h = 32 * scale, 40 * scale
    image = Image.new("RGBA", (label_w + 4 * (tile_w + pad) + pad, 100 + len(rows) * row_h), (250, 248, 243, 255))
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=18)
    small = ImageFont.load_default(size=14)
    draw.text((pad, 12), "Clankie screen faces: offline art review", fill="#503b2c", font=font)
    draw.text((pad, 40), "Normal face frames on existing moving bodies; right column is static Reduce Motion.", fill="#503b2c", font=small)
    for column, text in enumerate(["Normal 0", "Normal 1", "Normal 2", "Reduce Motion"]):
        draw.text((label_w + column * (tile_w + pad), 75), text, fill="#503b2c", font=small)
    for row_index, (label, face_name, body_name, body_indices) in enumerate(rows):
        top = 100 + row_index * row_h
        draw.text((pad, top + 20), label, fill="#503b2c", font=font)
        draw.text((pad, top + 48), face_name, fill="#6f5f36", font=small)
        face_tag = tags[face_name]
        for column in range(4):
            face_index = 0 if column == 3 else column
            face_frame = doc["frames"][face_tag["from"] + face_index]
            face = crop(sheet, face_frame)
            if column == 3:
                body = crop(sheet, doc["frames"][tags[body_name]["from"]])
                offset = geometry[body_name][0]
                caption = f"{body_name} 0 + face 0"
            else:
                body_index = body_indices[column]
                body = crop(sheet, doc["frames"][tags[body_name]["from"] + body_index])
                offset = geometry[body_name][body_index]
                caption = f"{body_name} {body_index}, face {face_index}: {face_frame['duration']} ms"
            body.alpha_composite(face, (offset["x"], offset["y"]))
            left = label_w + column * (tile_w + pad)
            tile = Image.new("RGBA", (tile_w, tile_h), (236, 232, 222, 255))
            tile.alpha_composite(body.resize((tile_w, tile_h), Image.Resampling.NEAREST))
            image.alpha_composite(tile, (left, top))
            draw.text((left, top + tile_h + 8), caption, fill="#503b2c", font=small)
    image.save(OUT / "frame-strip.png")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", required=True, help="Approved original-art git commit")
    args = parser.parse_args()
    doc, sheet, tags, geometry, evidence = verify(args.baseline)
    render_strip(doc, sheet, tags, geometry)
    (OUT / "art-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(f"verified {evidence['preservedFrames']} unchanged original crops, {evidence['validatedCompositions']} screen-only compositions; rendered {OUT / 'frame-strip.png'}")


if __name__ == "__main__":
    main()
