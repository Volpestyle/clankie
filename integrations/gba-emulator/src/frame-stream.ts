import {
  RENDERED_SURFACE_FRAME_MAX_BYTES,
  RenderedSurfaceFrameSchema,
  type RenderedSurfaceFrame,
} from "@clankie/interactive-environment";
import { createHash } from "node:crypto";
import { encodeFramebufferPng } from "./framebuffer-png.ts";
import type { MgbaFramebuffer } from "./mgba-core.ts";

/** Minimal structural view of a core. The stream never advances or inputs. */
export interface GbaFrameSource {
  framebuffer(): MgbaFramebuffer | null;
}

export interface GbaFrameStreamOptions {
  source: GbaFrameSource;
  /**
   * Minimum wall-clock gap between published frames. Clankie advances the core
   * in bursts rather than at 60fps, so a 20fps ceiling tracks how the agent
   * actually plays while capping encode cost.
   */
  minIntervalMs?: number;
  now?: () => number;
  timestamp?: () => string;
}

const DEFAULT_MIN_INTERVAL_MS = 50;

/**
 * Bounded, read-only frame publisher for the activity plane (ADR 0047).
 *
 * The stream is deliberately lossy: it rate-limits, and it drops frames whose
 * encoded bytes are identical to the previous frame. A Pokémon overworld that
 * nobody is moving through therefore costs nothing to "stream".
 */
export class GbaFrameStream {
  private readonly source: GbaFrameSource;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly timestamp: () => string;
  private sequence = 0;
  private lastPublishedAt = Number.NEGATIVE_INFINITY;
  private lastDigest: string | null = null;

  public constructor(options: GbaFrameStreamOptions) {
    this.source = options.source;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
    this.timestamp = options.timestamp ?? (() => new Date().toISOString());
  }

  /**
   * Capture the current framebuffer.
   *
   * Returns `null` when the frame is rate-limited, unchanged, or not yet
   * rendered. `force` bypasses both the rate limit and the unchanged check so a
   * newly joined viewer always receives a full frame.
   */
  public capture(frameNumber: number, options?: { force?: boolean }): RenderedSurfaceFrame | null {
    const force = options?.force ?? false;
    const at = this.now();
    if (!force && at - this.lastPublishedAt < this.minIntervalMs) return null;

    const framebuffer = this.source.framebuffer();
    if (framebuffer === null) return null;

    const png = encodeFramebufferPng(framebuffer);
    if (png.byteLength > RENDERED_SURFACE_FRAME_MAX_BYTES) {
      // Fail closed rather than publish an unbounded frame.
      throw new Error("gba_frame_exceeds_transport_bound");
    }
    const digest = createHash("sha256").update(png).digest("hex");
    if (!force && digest === this.lastDigest) return null;

    this.lastPublishedAt = at;
    this.lastDigest = digest;
    this.sequence += 1;

    return RenderedSurfaceFrameSchema.parse({
      schemaVersion: 1,
      surface: "gba_emulator",
      sequence: this.sequence,
      frame: frameNumber,
      width: framebuffer.width,
      height: framebuffer.height,
      encoding: "png",
      data: png.toString("base64"),
      byteLength: png.byteLength,
      sha256: digest,
      capturedAt: this.timestamp(),
    });
  }
}
