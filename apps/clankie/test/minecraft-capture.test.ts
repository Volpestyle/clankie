import { describe, expect, it, vi } from "vitest";
import type { MinecraftStatus } from "@clankie/protocol";
import type { ActivityFrameSink } from "@clankie/rendered-surface-client";
import { MinecraftCapture } from "../src/minecraft-capture.ts";

const session = { sessionId: "capture-test", connectionGeneration: 1 };
function fixture() {
  let status: MinecraftStatus = {
    session: { session, profileId: "local", phase: "active", termination: { state: "not_requested" } },
    actions: [],
  };
  const sink = { publishFrame: vi.fn(), close: vi.fn() } as unknown as ActivityFrameSink;
  const png = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png);
  png.write("IHDR", 12);
  png.writeUInt32BE(320, 16);
  png.writeUInt32BE(180, 20);
  const response = (headers: Record<string, string> = {}, body = png) =>
    new Response(body, {
      headers: {
        "content-type": "image/png",
        "x-minecraft-session-id": session.sessionId,
        "x-minecraft-connection-generation": "1",
        "x-frame-captured-at": "10000",
        "x-frame-width": "320",
        "x-frame-height": "180",
        ...headers,
      },
    });
  const getFrame = vi.fn(async () => response());
  const viewer = vi.fn(async () => ({
    session,
    available: true,
    frameUrl: "http://127.0.0.1:4329/frame.png",
  }));
  const createSink = vi.fn(async (): Promise<ActivityFrameSink | undefined> => sink);
  const capture = new MinecraftCapture({
    source: { status: async () => status, viewerStatus: viewer },
    createSink,
    fetch: getFrame as unknown as typeof fetch,
    now: () => 10000,
  });
  return {
    capture,
    sink,
    getFrame,
    viewer,
    response,
    createSink,
    setStatus: (value: MinecraftStatus) => {
      status = value;
    },
  };
}

describe("Minecraft capture", () => {
  it("retries a broker sink that becomes available during the same stay", async () => {
    const f = fixture();
    f.createSink.mockResolvedValueOnce(undefined);
    await f.capture.tick();
    expect(f.sink.publishFrame).not.toHaveBeenCalled();
    await f.capture.tick();
    expect(f.createSink).toHaveBeenCalledTimes(2);
    expect(f.sink.publishFrame).toHaveBeenCalledOnce();
    f.capture.close();
  });
  it("publishes bounded frames with source dimensions and repeats stable images for reconnects", async () => {
    const f = fixture();
    await f.capture.tick();
    await f.capture.tick();
    expect(f.sink.publishFrame).toHaveBeenCalledTimes(2);
    expect(f.sink.publishFrame).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "minecraft", width: 320, height: 180, sequence: 1 }),
    );
    f.capture.close();
  });
  it("closes stale live state and fences a frame whose session ended during capture", async () => {
    const f = fixture();
    f.getFrame.mockImplementation(async () => {
      f.setStatus({ session: null, actions: [] });
      return f.response();
    });
    await f.capture.tick();
    expect(f.sink.publishFrame).not.toHaveBeenCalled();
    expect(f.sink.close).toHaveBeenCalledTimes(1);
    f.capture.close();
  });
  it.each([
    ["another session", { "x-minecraft-session-id": "other" }, undefined, "minecraft_frame_session"],
    ["stale capture", { "x-frame-captured-at": "0" }, undefined, "minecraft_frame_stale"],
    ["oversize body", {}, Buffer.alloc(262145), "minecraft_frame_too_large"],
    ["false dimensions", { "x-frame-width": "400" }, undefined, "minecraft_frame_dimensions"],
  ])("rejects %s", async (_label, headers, body, error) => {
    const f = fixture();
    f.getFrame.mockImplementation(async () => f.response(headers, body));
    await expect(f.capture.tick()).rejects.toThrow(error);
    expect(f.sink.publishFrame).not.toHaveBeenCalled();
    f.capture.close();
  });
  it("refuses renderer redirects and non-loopback destinations", async () => {
    const f = fixture();
    f.viewer.mockResolvedValue({ session, available: true, frameUrl: "http://example.com/frame.png" });
    await expect(f.capture.tick()).rejects.toThrow("minecraft_frame_not_loopback");
    expect(f.getFrame).not.toHaveBeenCalled();
    f.capture.close();
  });
});
