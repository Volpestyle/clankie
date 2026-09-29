import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import {
  loadPersonaImages,
  PERSONA_IMAGE_LIMITS,
  personaImageMessage,
  personaImageStatus,
} from "../src/index.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "persona-video-"));
  roots.push(root);
  const images = join(root, "images"),
    cache = join(root, "cache");
  await mkdir(images);
  return { root, images, cache };
}
const art = new URL("../../../branding/clankie-logo-512.png", import.meta.url);
let ffmpegAvailable = true;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
} catch {
  ffmpegAvailable = false;
}
function clip(path: string, source = "color=c=red:s=32x32:r=10", codec = "libx264") {
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      source,
      "-t",
      "1.2",
      "-an",
      "-c:v",
      codec,
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      path,
    ],
    { timeout: 10_000 },
  );
}
it("roles follow the folder, prioritize appearance, and invalidate the description key", async () => {
  const { images, cache } = await fixture();
  await copyFile(art, join(images, "sprite.png"));
  const vibe = await loadPersonaImages(images, cache);
  await mkdir(join(images, "appearance"));
  await rename(join(images, "sprite.png"), join(images, "appearance", "sprite.png"));
  const appearance = await loadPersonaImages(images, cache);
  expect(appearance.hash).not.toBe(vibe.hash);
  expect(appearance.images[0]!.data).toBe(vibe.images[0]!.data);
  for (let i = 0; i < 8; i++) await copyFile(art, join(images, `${i}.png`));
  const board = await loadPersonaImages(images, cache);
  expect(personaImageStatus(board)).toMatchObject({ count: 8, appearanceCount: 1, vibeCount: 7 });
  expect(board.files[0]).toMatchObject({ name: "appearance/sprite.png", role: "appearance" });
  expect(board.files.at(-1)).toMatchObject({ status: "skipped", reason: "count_limit" });
  const content = personaImageMessage(board, true)!.content;
  expect(content[1]).toMatchObject({ text: "Appearance reference: how you look." });
  expect(content[3]).toMatchObject({
    text: expect.stringContaining("the feel of who you are, not what you look like"),
  });
});
it("reports missing ffmpeg and continues with still images", async () => {
  const { images, cache, root } = await fixture();
  await writeFile(join(images, "a.mov"), "not decoded");
  await copyFile(art, join(images, "b.png"));
  const board = await loadPersonaImages(images, cache, { ffmpeg: join(root, "ffmpeg"), ffprobe: "ffprobe" });
  expect(board.files[0]).toMatchObject({ status: "skipped", reason: "ffmpeg_missing" });
  expect(board.images).toHaveLength(1);
});
it.skipIf(!ffmpegAvailable).each(["mov", "mp4", "webm"])(
  "samples %s, deduplicates static frames and reuses cache without decoding",
  async (extension) => {
    const { images, cache, root } = await fixture();
    clip(join(images, `static.${extension}`), undefined, extension === "webm" ? "libvpx-vp9" : "libx264");
    const first = await loadPersonaImages(images, cache);
    expect(first.files[0]).toMatchObject({
      status: "loaded",
      kind: "video",
      frames: 1,
      duration: 1.2,
      timestamps: [0.2],
    });
    expect(first.images).toHaveLength(1);
    expect(first.images[0]!.role).toBe("vibe");
    // A tool that passes discovery but fails any attempted decode proves cache reuse.
    const tool = join(root, "ffmpeg");
    await writeFile(tool, '#!/bin/sh\n[ "$1" = "-version" ]\n', { mode: 0o700 });
    expect(await loadPersonaImages(images, cache, { ffmpeg: tool, ffprobe: tool })).toEqual(first);
    await rm(join(images, `static.${extension}`));
    clip(
      join(images, `static.${extension}`),
      "color=c=blue:s=32x32:r=10",
      extension === "webm" ? "libvpx-vp9" : "libx264",
    );
    expect((await loadPersonaImages(images, cache)).hash).not.toBe(first.hash);
  },
);
it.skipIf(!ffmpegAvailable)(
  "shares eight decoded slots across appearance, stills and evenly spaced video frames",
  async () => {
    const { images, cache } = await fixture();
    await mkdir(join(images, "appearance"));
    for (let i = 0; i < 6; i++) await copyFile(art, join(images, "appearance", `${i}.png`));
    clip(join(images, "vibe.mp4"), "testsrc2=s=96x96:r=10");
    const board = await loadPersonaImages(images, cache);
    expect(board.images).toHaveLength(8);
    expect(board.files.at(-1)).toMatchObject({
      status: "loaded",
      frames: 2,
      timestamps: [0.2, 0.6],
      reason: "count_limit",
    });
    expect(board.images.slice(0, 6).every((image) => image.role === "appearance")).toBe(true);
    const status = JSON.stringify(personaImageStatus(board));
    expect(status).not.toContain(board.images[7]!.data);
  },
);
it.skipIf(!ffmpegAvailable)(
  "reports invalid clips and missing ffprobe without aborting the board",
  async () => {
    const { images, cache, root } = await fixture();
    await writeFile(join(images, "invalid.mov"), "broken");
    expect((await loadPersonaImages(images, cache)).files[0]).toMatchObject({
      status: "error",
      reason: "video_decode_failed",
    });
    expect(
      (await loadPersonaImages(images, cache, { ffmpeg: "ffmpeg", ffprobe: join(root, "ffprobe") })).files[0],
    ).toMatchObject({ status: "skipped", reason: "ffprobe_missing" });
    const probe = join(root, "probe");
    await writeFile(probe, "#!/bin/sh\necho 601\n", { mode: 0o700 });
    expect(
      (await loadPersonaImages(images, cache, { ffmpeg: "ffmpeg", ffprobe: probe })).files[0],
    ).toMatchObject({ status: "error", reason: "video_duration_limit" });
  },
);

it("rejects oversized and symlink videos without decoding or requiring ffmpeg", async () => {
  const { images, cache, root } = await fixture();
  await writeFile(join(images, "big.mov"), "");
  await truncate(join(images, "big.mov"), PERSONA_IMAGE_LIMITS.videoBytes + 1);
  await symlink(join(images, "big.mov"), join(images, "link.mp4"));
  const board = await loadPersonaImages(images, cache, { ffmpeg: join(root, "ffmpeg"), ffprobe: "ffprobe" });
  expect(board.files[0]).toMatchObject({
    status: "error",
    reason: "source_size_limit",
    bytes: PERSONA_IMAGE_LIMITS.videoBytes + 1,
  });
  expect(board.files[1]!.status).toBe("error");
  expect(board.images).toHaveLength(0);
});
it.skipIf(!ffmpegAvailable)(
  "deduplicates repeated videos within a role without collapsing appearance into vibe",
  async () => {
    const { images, cache } = await fixture();
    await mkdir(join(images, "appearance"));
    clip(join(images, "a.mov"));
    await copyFile(join(images, "a.mov"), join(images, "b.mov"));
    await copyFile(join(images, "a.mov"), join(images, "appearance", "look.mov"));
    const board = await loadPersonaImages(images, cache);
    expect(personaImageStatus(board)).toMatchObject({ count: 2, appearanceCount: 1, vibeCount: 1 });
    expect(board.files.at(-1)).toMatchObject({ status: "skipped", frames: 0, reason: "duplicate_frames" });
  },
);
