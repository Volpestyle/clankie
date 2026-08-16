import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isShareArtifactRef } from "@clankie/protocol";
import { DiscordStreamWatchProjection } from "../src/stream-watch-observation.ts";

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
    expect(isShareArtifactRef(next.frame?.artifactRef ?? "")).toBe(true);
    const written = await readFile(join(root, "shares", `${next.frame!.artifactRef!.split(":")[1]}.jpg`));
    expect(written.equals(jpeg)).toBe(true);

    projection.apply({ schemaVersion: 1, source: "bot", streams: [], decoder: "idle" });
    expect(projection.current().streams[0]?.watching).toBe(true);
  });
});
