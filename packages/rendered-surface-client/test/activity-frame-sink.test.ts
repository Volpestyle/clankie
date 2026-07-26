import type { RenderedSurfaceFrame } from "@clankie/interactive-environment";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createActivityFrameSink, type ActivityFrameSocket } from "../src/activity-frame-sink.ts";

function frame(sequence: number): RenderedSurfaceFrame {
  const png = Buffer.from(`png-${sequence}`);
  return {
    schemaVersion: 1,
    surface: "gba_emulator",
    sequence,
    frame: sequence,
    width: 240,
    height: 160,
    encoding: "png",
    data: png.toString("base64"),
    byteLength: png.byteLength,
    sha256: createHash("sha256").update(png).digest("hex"),
    capturedAt: "2026-07-25T18:00:00.000Z",
  };
}

/** Controllable stand-in for the `ws` client. */
function fakeSocket(readyState = 1) {
  const listeners = new Map<string, () => void>();
  return {
    readyState,
    sent: [] as string[],
    send(payload: string) {
      this.sent.push(payload);
    },
    close: vi.fn(),
    on(event: "open" | "close" | "error", listener: () => void) {
      listeners.set(event, listener);
    },
    fire(event: "open" | "close" | "error") {
      listeners.get(event)?.();
    },
  };
}

describe("activity frame sink", () => {
  it("presents a bearer token and publishes frames when connected", () => {
    const socket = fakeSocket();
    const connect = vi.fn(() => socket as unknown as ActivityFrameSocket);
    const sink = createActivityFrameSink({
      url: "ws://127.0.0.1:4321/producer",
      token: "producer-secret",
      connect,
    });

    expect(connect).toHaveBeenCalledWith("ws://127.0.0.1:4321/producer", "producer-secret");
    expect(sink.connected).toBe(true);

    sink.publishFrame(frame(1));
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0] ?? "{}")).toMatchObject({ kind: "frame", frame: { sequence: 1 } });
  });

  it("drops frames rather than buffering them while disconnected", () => {
    const socket = fakeSocket(0); // CONNECTING, not OPEN
    const sink = createActivityFrameSink({
      url: "ws://127.0.0.1:4321/producer",
      token: "t",
      connect: () => socket as unknown as ActivityFrameSocket,
    });

    sink.publishFrame(frame(1));
    sink.publishFrame(frame(2));
    // A live surface must not replay a stale playthrough on reconnect.
    expect(socket.sent).toHaveLength(0);
    expect(sink.droppedFrameCount).toBe(2);
    expect(sink.connected).toBe(false);
  });

  it("reconnects after a drop but stops once closed", () => {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const scheduled: (() => void)[] = [];
    const sink = createActivityFrameSink({
      url: "ws://127.0.0.1:4321/producer",
      token: "t",
      connect: () => {
        const socket = fakeSocket();
        sockets.push(socket);
        return socket as unknown as ActivityFrameSocket;
      },
      setTimeoutImpl: (handler) => scheduled.push(handler),
    });

    expect(sockets).toHaveLength(1);
    sockets[0]?.fire("close");
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    expect(sockets).toHaveLength(2);

    // After an explicit close, a socket drop must not schedule another dial.
    sink.close();
    sockets[1]?.fire("close");
    expect(scheduled).toHaveLength(1);
  });
});
