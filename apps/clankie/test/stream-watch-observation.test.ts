import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isShareArtifactRef } from "@clankie/protocol";
import { DiscordStreamWatchProjection } from "../src/stream-watch-observation.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function sharesRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clankie-shares-"));
  roots.push(root);
  return root;
}

const stream = {
  schemaVersion: 1 as const,
  streamKey: "guild:g1:c1:u1",
  kind: "guild" as const,
  guildId: "g1",
  channelId: "c1",
  userId: "u1",
  watching: false,
  hasFrame: false,
  updatedAt: "2026-08-15T00:00:00.000Z",
};

describe("Discord stream-watch projection", () => {
  it("merges bot metadata with a user-session still instead of letting one wipe the other", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-shares-"));
    const projection = new DiscordStreamWatchProjection(root);

    projection.apply({ schemaVersion: 1, source: "bot", streams: [stream], decoder: "idle" });
    expect(projection.current().streams).toHaveLength(1);
    expect(projection.current().decoder).toBe("idle");

    const jpeg = Buffer.from("jpeg-bytes");
    const next = projection.apply({
      schemaVersion: 1,
      source: "user_session",
      streams: [{ ...stream, watching: true, hasFrame: true }],
      decoder: "ready",
      frame: {
        schemaVersion: 1,
        streamKey: stream.streamKey,
        userId: "u1",
        width: 1280,
        height: 720,
        jpegBase64: jpeg.toString("base64"),
        capturedAt: "2026-08-15T00:00:01.000Z",
      },
    });

    expect(next.streams[0]?.watching).toBe(true);
    expect(next.frame?.width).toBe(1280);
    expect(next.frame?.artifactRef).toBeDefined();
    expect(next.frames).toHaveLength(1);
    expect(isShareArtifactRef(next.frame?.artifactRef ?? "")).toBe(true);
    const written = await readFile(join(root, "shares", `${next.frame!.artifactRef!.split(":")[1]}.jpg`));
    expect(written.equals(jpeg)).toBe(true);

    projection.apply({ schemaVersion: 1, source: "bot", streams: [], decoder: "idle" });
    expect(projection.current().streams[0]?.watching).toBe(true);
  });

  it("keeps the latest four frames in chronological order for coarse motion", () => {
    const projection = new DiscordStreamWatchProjection();

    for (let second = 1; second <= 5; second += 1) {
      projection.apply({
        schemaVersion: 1,
        source: "user_session",
        streams: [{ ...stream, watching: true, hasFrame: true }],
        decoder: "ready",
        frame: {
          schemaVersion: 1,
          streamKey: stream.streamKey,
          userId: "u1",
          width: 1280,
          height: 720,
          jpegBase64: Buffer.from(`frame-${second}`).toString("base64"),
          capturedAt: `2026-08-15T00:00:0${second}.000Z`,
        },
      });
    }

    expect(
      projection.current().frames?.map((frame) => Buffer.from(frame.jpegBase64, "base64").toString()),
    ).toEqual(["frame-2", "frame-3", "frame-4", "frame-5"]);
    expect(projection.current().frame?.capturedAt).toBe("2026-08-15T00:00:05.000Z");
  });

  describe("still retention", () => {
    const report = (label: string) => ({
      schemaVersion: 1 as const,
      source: "user_session" as const,
      streams: [{ ...stream, watching: true, hasFrame: true }],
      decoder: "ready" as const,
      frame: {
        schemaVersion: 1 as const,
        streamKey: stream.streamKey,
        userId: "u1",
        width: 1280,
        height: 720,
        jpegBase64: Buffer.from(label.padEnd(100, ".")).toString("base64"),
        capturedAt: "2026-08-15T00:00:01.000Z",
      },
    });
    const digestOf = (artifactRef: string | undefined) => artifactRef!.split(":")[1]!;

    it("keeps disk within its byte budget while every shown still stays readable", async () => {
      const root = await sharesRoot();
      const projection = new DiscordStreamWatchProjection(root, {
        maxAgeMs: 60 * 60 * 1_000,
        maxBytes: 1_000,
      });
      const start = Date.parse("2026-08-15T00:00:00.000Z");
      for (let index = 0; index < 100; index += 1) {
        projection.apply(report(`frame-${index}`), new Date(start + index * 1_000));
      }

      const files = await readdir(join(root, "shares"));
      // 100-byte stills under a 1,000-byte budget.
      expect(files.length).toBeLessThanOrEqual(10);
      const shown = projection.current().frames ?? [];
      expect(shown).toHaveLength(4);
      for (const frame of shown) {
        const bytes = await readFile(join(root, "shares", `${digestOf(frame.artifactRef)}.jpg`));
        expect(bytes.equals(Buffer.from(frame.jpegBase64, "base64"))).toBe(true);
      }
    });

    it("retires stills by age but protects the current view", async () => {
      const root = await sharesRoot();
      const projection = new DiscordStreamWatchProjection(root, { maxAgeMs: 10_000, maxBytes: 1_000_000 });
      const start = Date.parse("2026-08-15T00:00:00.000Z");
      const early = projection.apply(report("early"), new Date(start));
      for (let index = 0; index < 4; index += 1) {
        projection.apply(report(`later-${index}`), new Date(start + 1_000 + index));
      }
      // Within the window a still that left the four-frame view is still readable.
      expect(await readdir(join(root, "shares"))).toContain(`${digestOf(early.frame?.artifactRef)}.jpg`);

      // A repeated frame refreshes its age instead of writing again.
      const repeated = projection.apply(report("later-3"), new Date(start + 20_000));
      const files = await readdir(join(root, "shares"));
      expect(files).not.toContain(`${digestOf(early.frame?.artifactRef)}.jpg`);
      for (const frame of repeated.frames ?? []) {
        expect(files).toContain(`${digestOf(frame.artifactRef)}.jpg`);
      }
    });

    it("adopts an earlier process's stills and retires the expired ones", async () => {
      const root = await sharesRoot();
      await mkdir(join(root, "shares"));
      const old = join(root, "shares", `${"a".repeat(64)}.jpg`);
      const fresh = join(root, "shares", `${"b".repeat(64)}.jpg`);
      await writeFile(old, "old");
      await writeFile(fresh, "fresh");
      const longAgo = new Date(Date.now() - 60 * 60 * 1_000);
      await utimes(old, longAgo, longAgo);
      await writeFile(join(root, "shares", "notes.txt"), "not a still");

      new DiscordStreamWatchProjection(root, { maxAgeMs: 10 * 60 * 1_000, maxBytes: 1_000_000 });
      expect((await readdir(join(root, "shares"))).sort()).toEqual([`${"b".repeat(64)}.jpg`, "notes.txt"]);
    });
  });
});
