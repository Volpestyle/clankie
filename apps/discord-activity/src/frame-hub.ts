import {
  type RenderedSurfaceFrame,
  type RenderedSurfaceAudio,
  type RenderedSurfaceMessage,
  type RenderedSurfaceOverlay,
  type RenderedSurfaceStatus,
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
 * The hub holds only the most recent frame, overlay, and work status. It is
 * not a recorder: nothing is persisted, and media bytes never reach a semantic
 * event stream. Audio is never retained for late viewers.
 */
export class RenderedSurfaceHub {
  private readonly viewers = new Set<RenderedSurfaceViewer>();
  private readonly maxBufferedBytes: number;
  private readonly maxViewers: number;
  private latestFrame: RenderedSurfaceFrame | null = null;
  private latestOverlay: RenderedSurfaceOverlay | null = null;
  private latestStatus: RenderedSurfaceStatus | null = null;
  private droppedFrames = 0;
  private droppedAudioPackets = 0;

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

  public get droppedAudioPacketCount(): number {
    return this.droppedAudioPackets;
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
    if (this.latestStatus !== null) {
      this.deliver(viewer, { kind: "status", status: this.latestStatus });
    }
    return true;
  }

  public removeViewer(viewer: RenderedSurfaceViewer): void {
    this.viewers.delete(viewer);
  }

  /** Latest PNG, if a producer is connected. Used as the Go Live send source. */
  public snapshot(): RenderedSurfaceFrame | null {
    return this.latestFrame;
  }

  public publishFrame(frame: RenderedSurfaceFrame): void {
    this.latestFrame = frame;
    this.broadcast({ kind: "frame", frame });
  }

  /** Audio is never replayed to a late viewer; only packets produced while connected are live. */
  public publishAudio(audio: RenderedSurfaceAudio): void {
    this.broadcast({ kind: "audio", audio });
  }

  public publishOverlay(overlay: RenderedSurfaceOverlay): void {
    this.latestOverlay = overlay;
    this.broadcast({ kind: "overlay", overlay });
  }

  public publishStatus(status: RenderedSurfaceStatus): void {
    this.latestStatus = status;
    this.broadcast({ kind: "status", status });
  }

  /** Tell every viewer the surface is done, then drop them. */
  public stop(reason: "operator_stop" | "session_ended"): void {
    this.broadcast({ kind: "stopped", reason });
    for (const viewer of this.viewers) viewer.close();
    this.viewers.clear();
    this.latestFrame = null;
    this.latestOverlay = null;
    this.latestStatus = null;
  }

  private broadcast(message: RenderedSurfaceMessage): void {
    for (const viewer of this.viewers) this.deliver(viewer, message);
  }

  private deliver(viewer: RenderedSurfaceViewer, message: RenderedSurfaceMessage): void {
    // Frames are droppable under backpressure; lifecycle messages are not.
    if (
      (message.kind === "frame" || message.kind === "audio") &&
      viewer.bufferedAmount > this.maxBufferedBytes
    ) {
      if (message.kind === "frame") this.droppedFrames += 1;
      else this.droppedAudioPackets += 1;
      return;
    }
    try {
      viewer.send(JSON.stringify(message));
    } catch {
      this.viewers.delete(viewer);
    }
  }
}
