import type {
  RenderedSurfaceAudio,
  RenderedSurfaceFrame,
  RenderedSurfaceOverlayV2,
  RenderedSurfaceStatus,
} from "@clankie/interactive-environment";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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

function audio(sequence: number): RenderedSurfaceAudio {
  const pcm = Buffer.alloc(16);
  return {
    schemaVersion: 1,
    surface: "gba_emulator",
    sequence,
    frame: sequence,
    encoding: "pcm_s16le",
    sampleRate: 65_536,
    channels: 2,
    frames: 4,
    data: pcm.toString("base64"),
    byteLength: pcm.byteLength,
    capturedAt: "2026-08-16T18:00:00.000Z",
  };
}

function status(phase: RenderedSurfaceStatus["phase"] = "thinking"): RenderedSurfaceStatus {
  return {
    schemaVersion: 1,
    surface: "gba_emulator",
    phase,
    updatedAt: "2026-08-16T18:00:00.000Z",
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
  it("ships a syntactically valid viewer with an explicit sound control", () => {
    const html = readFileSync(new URL("../src/client.html", import.meta.url), "utf8");
    const script = html.match(/<script type="module">([\s\S]+)<\/script>/u)?.[1];
    expect(html).toContain("Enable sound");
    expect(html).toContain("Sound ready");
    expect(script).toBeDefined();
    expect(() => new Function(script!)).not.toThrow();
  });

  it("ships an accessible work indicator with a reduced-motion fallback", () => {
    const html = readFileSync(new URL("../src/client.html", import.meta.url), "utf8");
    expect(html).toContain('id="work-status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("prefers-reduced-motion: reduce");
    expect(html).toContain('message.kind === "status"');
  });

  it("gives a late viewer the current frame and overlay instead of a blank canvas", () => {
    const hub = new RenderedSurfaceHub();
    hub.publishFrame(frame(1));
    hub.publishOverlay(overlay());
    hub.publishAudio(audio(1));
    hub.publishStatus(status());

    const late = viewer();
    expect(hub.addViewer(late)).toBe(true);

    const kinds = late.sent.map((payload) => JSON.parse(payload).kind);
    expect(kinds).toEqual(["frame", "overlay", "status"]);
    expect(JSON.parse(late.sent[0] ?? "{}").frame.sequence).toBe(1);
    expect(JSON.parse(late.sent[1] ?? "{}").overlay.monologue).toBe("The path north is clear.");
    expect(JSON.parse(late.sent[2] ?? "{}").status.phase).toBe("thinking");
  });

  it("drops frames for a backed-up viewer but never drops lifecycle messages", () => {
    const hub = new RenderedSurfaceHub({ maxBufferedBytes: 100 });
    const slow = viewer(5_000);
    const fast = viewer(0);
    hub.addViewer(slow);
    hub.addViewer(fast);

    hub.publishFrame(frame(1));
    hub.publishAudio(audio(1));
    expect(fast.sent).toHaveLength(2);
    expect(slow.sent).toHaveLength(0);
    // Dropping is counted, not silent.
    expect(hub.droppedFrameCount).toBe(1);
    expect(hub.droppedAudioPacketCount).toBe(1);

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
    expect(() => hub.publishAudio({ ...audio(1), byteLength: 15 })).toThrow();
    expect(() => hub.publishStatus({ ...status(), phase: "waiting" as never })).toThrow();
  });
});
