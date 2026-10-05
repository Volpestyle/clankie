import {
  type RenderedSurfaceFrame,
  type RenderedSurfaceAudio,
  type RenderedSurfaceMessage,
  type RenderedSurfaceOverlay,
  type RenderedSurfaceStatus,
  type ActivityShareMessage,
  type ActivityShareProducerMessage,
  type ActivityShareSession,
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
  /** Drop updates before the next payload would exceed this socket backlog. */
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
  private generation = 0;

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

  /** A replacement legacy producer is a new stream, including sequence zero. */
  public beginSession(): void {
    this.latestFrame = null;
    this.latestOverlay = null;
    this.latestStatus = null;
    this.generation += 1;
    this.broadcast({ kind: "reset", generation: this.generation });
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

  private broadcast(message: RenderedSurfaceMessage | { kind: "reset"; generation: number }): void {
    for (const viewer of this.viewers) this.deliver(viewer, message);
  }

  private deliver(
    viewer: RenderedSurfaceViewer,
    message: RenderedSurfaceMessage | { kind: "reset"; generation: number },
  ): void {
    const payload = JSON.stringify(message);
    if (viewer.bufferedAmount + Buffer.byteLength(payload) > this.maxBufferedBytes) {
      if (message.kind === "frame") this.droppedFrames += 1;
      else if (message.kind === "audio") this.droppedAudioPackets += 1;
      else if (message.kind === "stopped" || message.kind === "reset") {
        this.viewers.delete(viewer);
        viewer.close();
      }
      return;
    }
    try {
      viewer.send(payload);
    } catch {
      this.viewers.delete(viewer);
      viewer.close();
    }
  }
}

type ShareMedia = Exclude<ActivityShareProducerMessage, { kind: "stopped" }>;

/** A bounded live stream whose lifecycle is owned by ActivityShareRegistry. */
export class ActivityShareHub {
  private readonly viewers = new Set<RenderedSurfaceViewer>();
  private readonly maxBufferedBytes: number;
  private readonly maxViewers: number;
  private readonly retained = new Map<"frame" | "overlay" | "status", ShareMedia>();
  private readonly sequences = new Map<"frame" | "audio" | "overlay", number>();
  private session: ActivityShareSession;
  private droppedFrames = 0;
  private droppedAudioPackets = 0;
  private droppedUpdates = 0;

  public constructor(session: ActivityShareSession, options: RenderedSurfaceHubOptions = {}) {
    this.session = structuredClone(session);
    this.maxBufferedBytes = bounded(
      options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
      DEFAULT_MAX_BUFFERED_BYTES,
    );
    this.maxViewers = bounded(options.maxViewers ?? DEFAULT_MAX_VIEWERS, DEFAULT_MAX_VIEWERS);
  }

  public addViewer(viewer: RenderedSurfaceViewer): boolean {
    if (this.viewers.size >= this.maxViewers) {
      viewer.close();
      return false;
    }
    this.viewers.add(viewer);
    this.deliver(viewer, { kind: "session", session: this.session });
    for (const message of this.retained.values()) this.deliver(viewer, message);
    return this.viewers.has(viewer);
  }

  public removeViewer(viewer: RenderedSurfaceViewer): void {
    this.viewers.delete(viewer);
  }

  public stats(): {
    viewerCount: number;
    droppedFrameCount: number;
    droppedAudioPacketCount: number;
    droppedUpdateCount: number;
  } {
    return {
      viewerCount: this.viewers.size,
      droppedFrameCount: this.droppedFrames,
      droppedAudioPacketCount: this.droppedAudioPackets,
      droppedUpdateCount: this.droppedUpdates,
    };
  }

  public reset(session: ActivityShareSession): void {
    this.session = structuredClone(session);
    this.retained.clear();
    this.sequences.clear();
    this.broadcast({ kind: "session", session: this.session });
  }

  public publish(message: ShareMedia): void {
    if (message.shareId !== this.session.shareId || message.generation !== this.session.generation) return;
    if (message.kind !== "status") {
      const sequence =
        message.kind === "frame"
          ? message.frame.sequence
          : message.kind === "audio"
            ? message.audio.sequence
            : message.overlay.sequence;
      if (sequence <= (this.sequences.get(message.kind) ?? -1)) return;
      this.sequences.set(message.kind, sequence);
    }
    if (message.kind !== "audio") this.retained.set(message.kind, message);
    this.broadcast(message);
  }

  public stop(reason: "operator_stop" | "session_ended" | "expired"): void {
    this.broadcast({
      kind: "stopped",
      shareId: this.session.shareId,
      generation: this.session.generation,
      reason,
    });
    for (const viewer of this.viewers) viewer.close();
    this.viewers.clear();
    this.retained.clear();
    this.sequences.clear();
  }

  private broadcast(message: ActivityShareMessage): void {
    for (const viewer of this.viewers) this.deliver(viewer, message);
  }

  private deliver(viewer: RenderedSurfaceViewer, message: ActivityShareMessage): void {
    const payload = JSON.stringify(message);
    if (viewer.bufferedAmount + Buffer.byteLength(payload) > this.maxBufferedBytes) {
      if (message.kind === "frame") this.droppedFrames += 1;
      else if (message.kind === "audio") this.droppedAudioPackets += 1;
      else this.droppedUpdates += 1;
      // Updates may be dropped. Lifecycle cannot wait behind stale media: close
      // the socket instead of adding another message to its full write queue.
      if (message.kind === "session" || message.kind === "stopped") {
        this.viewers.delete(viewer);
        viewer.close();
      }
      return;
    }
    try {
      viewer.send(payload);
    } catch {
      this.viewers.delete(viewer);
      viewer.close();
    }
  }
}

function bounded(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error("invalid_hub_limit");
  return value;
}
