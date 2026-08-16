import { describe, expect, it } from "vitest";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { LaneLog } from "../src/captain/lane-log.ts";
import { captainTools } from "../src/captain/tools.ts";

describe("captain observe_share tool", () => {
  it("gives the model chronological share frames for coarse motion", async () => {
    const frames = [1, 2, 3, 4].map((second) => ({
      streamKey: "guild:g1:c1:u1",
      userId: "u1",
      width: 1280,
      height: 720,
      jpegBase64: Buffer.from(`frame-${second}`).toString("base64"),
      capturedAt: `2026-08-15T00:00:0${second}.000Z`,
    }));
    const deps = {
      embodiment: {
        submitIntent: () => Promise.reject(new Error("unused")),
        getSession: () => Promise.reject(new Error("unused")),
        getLiveSession: () => Promise.reject(new Error("unused")),
      },
      streamWatch: {
        current: () =>
          Promise.resolve({
            schemaVersion: 1 as const,
            streams: [
              {
                schemaVersion: 1 as const,
                streamKey: "guild:g1:c1:u1",
                kind: "guild" as const,
                guildId: "g1",
                channelId: "c1",
                userId: "u1",
                watching: true,
                hasFrame: true,
                updatedAt: "2026-08-15T00:00:04.000Z",
              },
            ],
            frame: frames.at(-1),
            frames,
            decoder: "ready" as const,
          }),
      },
    } as unknown as CaptainDeps;
    const observe = captainTools(deps, {}, {} as LaneLog, "discord_voice").find(
      (tool) => tool.name === "observe_share",
    );
    if (observe === undefined) throw new Error("observe_share is missing");

    const result = await observe.execute("call-1", {}, undefined, undefined, {} as never);

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("oldest_to_newest"),
    });
    expect(result.content.slice(1)).toEqual(
      frames.map((frame) => ({ type: "image", data: frame.jpegBase64, mimeType: "image/jpeg" })),
    );
  });
});
