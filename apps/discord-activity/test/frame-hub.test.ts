import type { RenderedSurfaceFrame, RenderedSurfaceOverlayV2 } from "@clankie/interactive-environment";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RenderedSurfaceHub, type RenderedSurfaceViewer } from "../src/frame-hub.ts";

function frame(sequence: number): RenderedSurfaceFrame {
  const png = Buffer.from(`png-bytes-${sequence}`);
  return {
    schemaVersion: 1,
    surface: "gba_emulator",
    sequence,
    frame: sequence * 10,
    width: 240,
    height: 160,
    encoding: "png",
    data: png.toString("base64"),
    byteLength: png.byteLength,
    sha256: createHash("sha256").update(png).digest("hex"),
    capturedAt: "2026-07-25T18:00:00.000Z",
  };
}

function overlay(): RenderedSurfaceOverlayV2 {
  return {
    schemaVersion: 2,
    surface: "gba_emulator",
    sequence: 1,
    objective: "reach Pewter City",
    intent: "take the north path",
    monologue: "The path north is clear.",
    effect: "entered Viridian Forest",
    updatedAt: "2026-07-25T18:00:00.000Z",
  };
}

function viewer(bufferedAmount = 0): RenderedSurfaceViewer & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    send: (payload: string) => sent.push(payload),
    bufferedAmount,
    close: vi.fn(),
  };
}

describe("RenderedSurfaceHub", () => {
  it("gives a late viewer the current frame and overlay instead of a blank canvas", () => {
    const hub = new RenderedSurfaceHub();
    hub.publishFrame(frame(1));
    hub.publishOverlay(overlay());

    const late = viewer();
    expect(hub.addViewer(late)).toBe(true);

    const kinds = late.sent.map((payload) => JSON.parse(payload).kind);
    expect(kinds).toEqual(["frame", "overlay"]);
    expect(JSON.parse(late.sent[0] ?? "{}").frame.sequence).toBe(1);
    expect(JSON.parse(late.sent[1] ?? "{}").overlay.monologue).toBe("The path north is clear.");
  });

  it("drops frames for a backed-up viewer but never drops lifecycle messages", () => {
    const hub = new RenderedSurfaceHub({ maxBufferedBytes: 100 });
    const slow = viewer(5_000);
    const fast = viewer(0);
    hub.addViewer(slow);
    hub.addViewer(fast);

    hub.publishFrame(frame(1));
    expect(fast.sent).toHaveLength(1);
    expect(slow.sent).toHaveLength(0);
    // Dropping is counted, not silent.
    expect(hub.droppedFrameCount).toBe(1);

    hub.stop("operator_stop");
    // The slow viewer still learns the surface ended.
    expect(JSON.parse(slow.sent.at(-1) ?? "{}")).toMatchObject({
      kind: "stopped",
      reason: "operator_stop",
    });
    expect(hub.viewerCount).toBe(0);
  });

  it("bounds concurrent viewers and rejects a malformed frame", () => {
    const hub = new RenderedSurfaceHub({ maxViewers: 1 });
    expect(hub.addViewer(viewer())).toBe(true);
    const rejected = viewer();
    expect(hub.addViewer(rejected)).toBe(false);
    expect(rejected.close).toHaveBeenCalled();

    // byteLength must describe the payload it ships with.
    expect(() => hub.publishFrame({ ...frame(1), byteLength: 999 })).toThrow();
    expect(() => hub.publishOverlay({ ...overlay(), monologue: "x".repeat(257) })).toThrow();
  });
});
