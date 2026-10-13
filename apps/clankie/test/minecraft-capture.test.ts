import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minecraftExtension } from "@clankie/minecraft";
import { GameExtensionRegistry } from "@clankie/game-extension";
import type { MinecraftStatus } from "@clankie/protocol";
import type { ActivityFrameSink } from "@clankie/rendered-surface-client";
import { MinecraftCapture } from "../src/minecraft-capture.ts";
import { BodyLeaseStore } from "../src/body-leases.ts";
import { FakeMinecraftPort } from "./minecraft-fake.ts";

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
  it("does not poll configured idle destinations and resumes capture polling within 500 ms of joining", async () => {
    const root = mkdtempSync(join(tmpdir(), "minecraft-capture-polling-"));
    const store = new BodyLeaseStore(join(root, "leases"));
    const port = new FakeMinecraftPort([{ id: "local", name: "Configured destination" }]);
    const status = vi.spyOn(port, "status");
    const runtime = new GameExtensionRegistry().register(minecraftExtension, {
      port,
      store,
      path: join(root, "session.json"),
      capture: { createSink: async () => undefined },
    });
    vi.useFakeTimers();
    try {
      runtime.activate();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(status).not.toHaveBeenCalled();
      const joined = await runtime.service.join("local", {
        conversationId: "capture-owner",
        current: () => true,
        authorize: async () => true,
      });
      port.confirmJoined(joined.session);
      await vi.advanceTimersByTimeAsync(500);
      expect(status).toHaveBeenCalled();
      const activeCalls = status.mock.calls.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(status.mock.calls.length).toBeGreaterThan(activeCalls);
      port.confirmDisconnected(joined.session);
      await vi.advanceTimersByTimeAsync(500);
      expect(runtime.service.ownsPlay()).toBe(false);
      status.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(status).not.toHaveBeenCalled();
    } finally {
      await runtime.deactivate();
      vi.useRealTimers();
      status.mockRestore();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
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
