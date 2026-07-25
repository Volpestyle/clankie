import {
  RenderedSurfaceFrameSchema,
  RenderedSurfaceOverlaySchema,
  type RenderedSurfaceFrame,
  type RenderedSurfaceMessage,
  type RenderedSurfaceOverlay,
} from "@clankie/interactive-environment";

/**
 * A connected activity viewer. Kept structural so tests never open a socket.
 *
 * `bufferedAmount` is the backpressure signal: a viewer whose socket is behind
 * gets frames dropped rather than queued, which is the correct behaviour for a
 * live surface and the reason this hub needs no unbounded buffer.
 */
export interface RenderedSurfaceViewer {
  send(payload: string): void;
  readonly bufferedAmount: number;
  close(): void;
}

export interface RenderedSurfaceHubOptions {
  /** Drop frames for a viewer once its socket backlog exceeds this many bytes. */
  maxBufferedBytes?: number;
  /** Hard ceiling on concurrent viewers. */
  maxViewers?: number;
}

const DEFAULT_MAX_BUFFERED_BYTES = 512 * 1024;
const DEFAULT_MAX_VIEWERS = 64;

/**
 * Fan-out for the activity plane's frame stream (ADR 0047).
 *
 * The hub holds only the most recent frame and overlay. It is not a recorder:
 * nothing is persisted, and frame bytes never reach a semantic event stream.
 */
export class RenderedSurfaceHub {
  private readonly viewers = new Set<RenderedSurfaceViewer>();
  private readonly maxBufferedBytes: number;
  private readonly maxViewers: number;
  private latestFrame: RenderedSurfaceFrame | null = null;
  private latestOverlay: RenderedSurfaceOverlay | null = null;
  private droppedFrames = 0;

  public constructor(options: RenderedSurfaceHubOptions = {}) {
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.maxViewers = options.maxViewers ?? DEFAULT_MAX_VIEWERS;
  }

  public get viewerCount(): number {
    return this.viewers.size;
  }

  /** Frames dropped for backpressure since start. Surfaced, never silent. */
  public get droppedFrameCount(): number {
    return this.droppedFrames;
  }

  /**
   * Admit a viewer and immediately send it the current surface state, so a
   * late joiner never stares at a blank canvas waiting for the next change.
   */
  public addViewer(viewer: RenderedSurfaceViewer): boolean {
    if (this.viewers.size >= this.maxViewers) {
      viewer.close();
      return false;
    }
    this.viewers.add(viewer);
    if (this.latestFrame !== null) {
      this.deliver(viewer, { kind: "frame", frame: this.latestFrame });
    }
    if (this.latestOverlay !== null) {
      this.deliver(viewer, { kind: "overlay", overlay: this.latestOverlay });
    }
    return true;
  }

  public removeViewer(viewer: RenderedSurfaceViewer): void {
    this.viewers.delete(viewer);
  }

  public publishFrame(frame: RenderedSurfaceFrame): void {
    const validated = RenderedSurfaceFrameSchema.parse(frame);
    this.latestFrame = validated;
    this.broadcast({ kind: "frame", frame: validated });
  }

  public publishOverlay(overlay: RenderedSurfaceOverlay): void {
    const validated = RenderedSurfaceOverlaySchema.parse(overlay);
    this.latestOverlay = validated;
    this.broadcast({ kind: "overlay", overlay: validated });
  }

  /** Tell every viewer the surface is done, then drop them. */
  public stop(reason: "operator_stop" | "session_ended"): void {
    this.broadcast({ kind: "stopped", reason });
    for (const viewer of this.viewers) viewer.close();
    this.viewers.clear();
    this.latestFrame = null;
    this.latestOverlay = null;
  }

  private broadcast(message: RenderedSurfaceMessage): void {
    for (const viewer of this.viewers) this.deliver(viewer, message);
  }

  private deliver(viewer: RenderedSurfaceViewer, message: RenderedSurfaceMessage): void {
    // Frames are droppable under backpressure; lifecycle messages are not.
    if (message.kind === "frame" && viewer.bufferedAmount > this.maxBufferedBytes) {
      this.droppedFrames += 1;
      return;
    }
    try {
      viewer.send(JSON.stringify(message));
    } catch {
      this.viewers.delete(viewer);
    }
  }
}
