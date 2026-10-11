import { deflateSync } from "node:zlib";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import jpeg from "jpeg-js";
import {
  buildLeadSkin,
  decodePNG,
  decodeLeadAtlas,
  renderLeadSkinSheets,
  digest,
  encodePNG,
  LEAD_SKIN_LIMITS,
  SKIN_LEAD_ANIMATION_KEYS,
  sampleReference,
  verifyLeadSkinArtifact,
  validateSkinLeadPackForReview,
  type LeadSkinSource,
} from "../src/index.ts";

function pngWithRaw(width: number, height: number, raw: Buffer) {
  const chunk = (name: string, data: Buffer) => {
    const bytes = Buffer.concat([Buffer.alloc(4), Buffer.from(name), data, Buffer.alloc(4)]);
    bytes.writeUInt32BE(data.length);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(4, -4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4);
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Mathematical sentinel cells, not character art or reference-derived colors.
function source(): LeadSkinSource {
  const rows = Array.from({ length: 64 }, (_, y) =>
    y >= 2 && y < 63 ? ".".repeat(14) + "XX" + ".".repeat(16) : ".".repeat(32),
  );
  return {
    skin: {
      id: "test.grid",
      version: "1.0.0",
      displayName: "Diagnostic grid",
      cell: { width: 32, height: 64 },
      scale: 1,
      animations: [...SKIN_LEAD_ANIMATION_KEYS],
    },
    palette: { ".": [0, 0, 0, 0], X: [255, 0, 0, 255] },
    tags: SKIN_LEAD_ANIMATION_KEYS.map((name) => ({
      name,
      direction: "forward",
      repeat: name === "hop" ? 1 : undefined,
      frames: [{ duration: 250, rows }],
    })),
  };
}
describe("lead-skin data boundary", () => {
  it("compiles native tall grids deterministically and verifies immutable artifacts", () => {
    const input = source(),
      a = buildLeadSkin(input),
      b = buildLeadSkin(input);
    expect(a.png.equals(b.png)).toBe(true);
    const decoded = decodePNG(a.png);
    expect([decoded.width, decoded.height]).toEqual([24 * 32, 64]);
    expect([...decoded.rgba.subarray((2 * decoded.width + 14) * 4, (2 * decoded.width + 15) * 4)]).toEqual([
      255, 0, 0, 255,
    ]);
    expect(a.manifest.lead.origin).toEqual({ x: 15, y: 63 });
    expect(a.manifest.lead.bounds).toEqual({ x: 14, y: 2, width: 2, height: 61 });
    expect(a.manifest.lead.animations.hop?.playback).toBe("once");
    expect(a.manifest.lead.animations.idle.frameDurationsMs).toEqual([250]);
    const long = source();
    long.tags[0]!.frames = Array.from({ length: 13 }, () => long.tags[0]!.frames[0]!);
    const compiled = buildLeadSkin(long);
    const pages = [...renderLeadSkinSheets(compiled.manifest, compiled.png)];
    expect(
      pages
        .flatMap((p) => p.rows)
        .filter((r) => r.animation === "idle")
        .flatMap((r) => r.frameIds),
    ).toEqual(compiled.manifest.lead.animations.idle.frames);
    const json = Buffer.from(JSON.stringify(a.manifest));
    expect(
      verifyLeadSkinArtifact(json, a.png, { manifestSha256: digest(json), atlasSha256: digest(a.png) }),
    ).toEqual(a.manifest);
  });
  it("rejects incomplete coverage, oversized grids, bad palettes and invalid timing before publication", () => {
    const missing = source();
    missing.tags = missing.tags.filter((t) => t.name !== "walk_up");
    expect(() => buildLeadSkin(missing)).toThrow(/walk_up/);
    const large = source();
    large.skin.cell.height = 97;
    expect(() => buildLeadSkin(large)).toThrow(/grid limits/);
    const palette = source();
    palette.palette.X = [1, 2, 3, 4];
    expect(() => buildLeadSkin(palette)).toThrow(/palette/);
    const timing = source();
    timing.tags[0]!.frames[0]!.duration = Infinity;
    expect(() => buildLeadSkin(timing)).toThrow(/timing/);
    const bad = buildLeadSkin(source()).manifest;
    bad.lead.atlas.frames["lead.0"]!.x = LEAD_SKIN_LIMITS.atlasDimension;
    expect(() => validateSkinLeadPackForReview(bad)).toThrow(/rectangle/);
    const anchor = buildLeadSkin(source()).manifest;
    anchor.lead.origin.y = 65;
    expect(() => validateSkinLeadPackForReview(anchor)).toThrow(/lead.origin/);
    const version = { ...buildLeadSkin(source()).manifest, contractVersion: 2 };
    expect(() => validateSkinLeadPackForReview(version)).toThrow(/incompatible_contract_version/);
  });
  it("rejects corrupted bytes, digest mismatch, mismatched dimensions and truncated/bomb PNGs", () => {
    const { manifest, png } = buildLeadSkin(source()),
      json = Buffer.from(JSON.stringify(manifest)),
      hashes = { manifestSha256: digest(json), atlasSha256: digest(png) };
    const corrupt = Buffer.from(png);
    corrupt[50] = corrupt[50]! ^ 1;
    expect(() => verifyLeadSkinArtifact(json, corrupt, hashes)).toThrow(/digest/);
    expect(() => decodePNG(corrupt)).toThrow(/CRC/);
    expect(() => decodePNG(png.subarray(0, png.length - 12))).toThrow(/incomplete/);
    manifest.lead.atlas.width++;
    const changed = Buffer.from(JSON.stringify(manifest));
    expect(() =>
      verifyLeadSkinArtifact(changed, png, { ...hashes, manifestSha256: digest(changed) }),
    ).toThrow(/match/);
    expect(() => decodePNG(Buffer.alloc(16 * 1024 * 1024 + 1))).toThrow(/bytes/);
    expect(() => decodeLeadAtlas(encodePNG(1, 97, Buffer.alloc(97 * 4)))).toThrow(/dimensions/);
    // A tiny valid header cannot inflate beyond its declared five-byte scanline.
    const bomb = pngWithRaw(1, 1, Buffer.alloc(1024 * 1024));
    expect(() => decodePNG(bomb)).toThrow();
  });
  it("samples explicit and measured grids without squashing, preserves transparency and reuses an approved palette", () => {
    const width = 16,
      height = 24,
      rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        rgba.set(x < 8 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * width + x) * 4);
    const png = encodePNG(width, height, rgba);
    const sample = sampleReference(png, {
      grid: { pitch: 4, columns: 4, rows: 6 },
      approvedPalette: [
        [255, 0, 0],
        [0, 0, 255],
      ],
    });
    expect([sample.image.width, sample.image.height]).toEqual([4, 6]);
    expect(sample.palette).toEqual([
      [255, 0, 0],
      [0, 0, 255],
    ]);
    expect(sampleReference(png).grid).toMatchObject({ estimated: true });
    expect(() => sampleReference(png, { grid: { pitch: 0 } })).toThrow(/grid/);
    const transparent = sampleReference(encodePNG(4, 4, Buffer.alloc(64)), { grid: { pitch: 1 } });
    expect(transparent.image.rgba.equals(Buffer.alloc(64))).toBe(true);
    const bg = Buffer.alloc(5 * 5 * 4, 255);
    for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) bg.set([255, 0, 0, 255], (y * 5 + x) * 4);
    bg.set([255, 255, 255, 255], (2 * 5 + 2) * 4);
    const cleaned = sampleReference(encodePNG(5, 5, bg), {
      grid: { pitch: 1 },
      background: [255, 255, 255],
      colors: 2,
    });
    expect(cleaned.image.rgba[3]).toBe(0);
    expect([...cleaned.image.rgba.subarray(48, 52)]).toEqual([255, 255, 255, 255]);
    const jpg = jpeg.encode({ width, height, data: rgba }, 100).data;
    expect(sampleReference(Buffer.from(jpg), { grid: { pitch: 4 } }).image.height).toBe(6);
  });
  it("runs the bundled release CLI against data without workspace dependencies, provider or appearance write", async () => {
    const root = await mkdtemp(join(tmpdir(), "lead-compiler-")),
      input = join(root, "source"),
      output = join(root, "pack");
    try {
      const value = source();
      await mkdir(join(input, "src"), { recursive: true });
      await writeFile(join(input, "skin.json"), JSON.stringify(value.skin));
      await writeFile(join(input, "palette.txt"), "X ff0000 sentinel\n");
      for (const tag of value.tags)
        await writeFile(
          join(input, "src", `${tag.name}.txt`),
          `direction forward\n${tag.repeat === 1 ? "repeat 1\n" : ""}frame 250\n${tag.frames[0]!.rows.join("\n")}\n`,
        );
      const repo = new URL("../../../", import.meta.url).pathname;
      const cli = join(root, "clankie.mjs");
      const run = promisify(execFile);
      await run(
        join(repo, "node_modules/esbuild/bin/esbuild"),
        [
          "apps/tui/bin/clankie.ts",
          "--bundle",
          "--platform=node",
          "--format=esm",
          "--target=node24",
          `--outfile=${cli}`,
          '--banner:js=import { createRequire as __clankieCreateRequire } from "node:module"; const require = __clankieCreateRequire(import.meta.url);',
          "--external:@browser_use/pi",
          "--external:mineflayer",
          "--external:mineflayer-pathfinder",
          "--external:minecraft-data",
          "--external:prismarine-viewer",
          "--external:playwright-core",
          "--external:express",
          "--external:socket.io",
          "--external:vec3",
        ],
        { cwd: repo },
      );
      const result = await run(process.execPath, [cli, "skin", "compile", input, "--out", output], {
        cwd: root,
        env: { ...process.env, CLANKIE_SETTINGS: join(root, "absent-settings.json") },
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: "ok",
        ownerApproval: "not_checked",
        visualReview: "not_checked",
      });
      const check = await run(process.execPath, [cli, "skin", "check", output], { cwd: root });
      expect(JSON.parse(check.stdout)).toMatchObject({ mechanicalValidation: "passed" });
      expect((await readFile(join(output, "lead.png"))).length).toBeGreaterThan(0);
      const options = join(root, "options.json");
      await writeFile(options, JSON.stringify({ grid: { pitch: 1, columns: 32, rows: 64 }, colors: 2 }));
      const sampled = await run(
        process.execPath,
        [cli, "skin", "sample", join(output, "lead.png"), options, "--out", join(root, "sample")],
        { cwd: root },
      );
      expect(JSON.parse(sampled.stdout)).toMatchObject({
        approvalRequired: true,
        grid: { columns: 32, rows: 64 },
      });
      // A valid large pack's complete review metadata exceeds the small recipe/options limit.
      await writeFile(
        join(input, "src", "idle.txt"),
        Array.from({ length: 300 }, () => `frame 250\n${value.tags[0]!.frames[0]!.rows.join("\n")}\n`).join(
          "\n",
        ),
      );
      const larger = join(root, "larger-pack");
      await run(process.execPath, [cli, "skin", "compile", input, "--out", larger], { cwd: root });
      expect((await readFile(join(larger, "artifact.json"))).length).toBeGreaterThan(16384);
      expect(
        JSON.parse((await run(process.execPath, [cli, "skin", "check", larger], { cwd: root })).stdout),
      ).toMatchObject({ mechanicalValidation: "passed" });
      await expect(
        run(process.execPath, [cli, "skin", "compile", input, "--out", output], { cwd: root }),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
