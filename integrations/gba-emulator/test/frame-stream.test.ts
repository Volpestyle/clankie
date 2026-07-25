import { RenderedSurfaceFrameSchema } from "@clankie/interactive-environment";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeFramebufferPng } from "../src/framebuffer-png.ts";
import { GbaFrameStream } from "../src/frame-stream.ts";
import type { MgbaFramebuffer } from "../src/mgba-core.ts";

const WIDTH = 240;
const HEIGHT = 160;

function framebuffer(fill: number): MgbaFramebuffer {
  const bytes = new Uint8Array(WIDTH * HEIGHT * 2);
  for (let i = 0; i < bytes.length; i += 2) {
    bytes[i] = fill & 0xff;
    bytes[i + 1] = (fill >> 8) & 0xff;
  }
  return { width: WIDTH, height: HEIGHT, bytes };
}

describe("GbaFrameStream", () => {
  it("publishes a bounded, digest-verified PNG envelope", () => {
    const clock = 1_000;
    const stream = new GbaFrameStream({
      source: { framebuffer: () => framebuffer(0x1234) },
      now: () => clock,
      timestamp: () => "2026-07-25T18:00:00.000Z",
    });

    const frame = stream.capture(42);
    expect(frame).not.toBeNull();
    const parsed = RenderedSurfaceFrameSchema.parse(frame);
    expect(parsed).toMatchObject({ surface: "gba_emulator", encoding: "png", frame: 42, sequence: 1 });

    // The envelope's digest and length describe the bytes it actually carries.
    const decoded = Buffer.from(parsed.data, "base64");
    expect(decoded.byteLength).toBe(parsed.byteLength);
    expect(createHash("sha256").update(decoded).digest("hex")).toBe(parsed.sha256);

    // It is a real PNG, not an opaque blob.
    expect(decoded.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");

    // A flat GBA frame stays far under the transport bound.
    expect(parsed.byteLength).toBeLessThan(32 * 1024);
  });

  it("drops rate-limited and unchanged frames but always honours a forced keyframe", () => {
    let clock = 1_000;
    let fill = 0x1234;
    const stream = new GbaFrameStream({
      source: { framebuffer: () => framebuffer(fill) },
      minIntervalMs: 50,
      now: () => clock,
      timestamp: () => "2026-07-25T18:00:00.000Z",
    });

    expect(stream.capture(1)).not.toBeNull();

    // Inside the rate-limit window.
    clock += 10;
    expect(stream.capture(2)).toBeNull();

    // Past the window, but the picture has not changed — no frame is worth sending.
    clock += 100;
    expect(stream.capture(3)).toBeNull();

    // A late-joining viewer still gets a full frame on demand.
    const keyframe = stream.capture(3, { force: true });
    expect(keyframe).not.toBeNull();
    expect(keyframe?.sequence).toBe(2);

    // A changed picture publishes again, and sequence stays monotonic.
    clock += 100;
    fill = 0x4321;
    const changed = stream.capture(4);
    expect(changed?.sequence).toBe(3);
    expect(changed?.sha256).not.toBe(keyframe?.sha256);
  });

  it("returns null before the core has rendered and rejects a truncated framebuffer", () => {
    const stream = new GbaFrameStream({ source: { framebuffer: () => null } });
    expect(stream.capture(0)).toBeNull();

    expect(() => encodeFramebufferPng({ width: WIDTH, height: HEIGHT, bytes: new Uint8Array(8) })).toThrow(
      /truncated/,
    );
  });
});
