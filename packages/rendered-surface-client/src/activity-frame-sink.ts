import { resolveActivityProducerCredential } from "@clankie/credential-broker";
import type {
  RenderedSurfaceAudio,
  RenderedSurfaceFrame,
  RenderedSurfaceOverlay,
  RenderedSurfaceStatus,
} from "@clankie/interactive-environment";
import { WebSocket } from "ws";

/**
 * Runner-side producer for the activity plane (ADR 0047).
 *
 * The runner dials **out** to the activity server rather than accepting an
 * inbound connection: the trusted runner holds credentials and should not open
 * a port for an internet-facing surface to connect into.
 *
 * The sink is lossy on purpose. A live surface that buffers frames while
 * disconnected would replay a stale playthrough on reconnect, so frames are
 * dropped when the socket is not open and the viewer simply resumes at the
 * present moment.
 */
export interface ActivityFrameSinkOptions {
  /** Loopback producer endpoint, e.g. ws://127.0.0.1:4321/producer */
  url: string;
  /**
   * Broker-resolved bearer. Callers obtain it with
   * `resolveActivityProducerCredential()`; it is never read from the
   * environment, so it stays out of shell history and process listings.
   */
  token: string;
  reconnectDelayMs?: number;
  /** Injected for tests; defaults to the real `ws` client. */
  connect?: (url: string, token: string) => ActivityFrameSocket;
  setTimeoutImpl?: (handler: () => void, ms: number) => unknown;
}

/** Structural view of the producer socket so tests never open one. */
export interface ActivityFrameSocket {
  readyState: number;
  send(payload: string): void;
  close(): void;
  on(event: "open" | "close" | "error", listener: () => void): void;
}

export interface ActivityFrameSink {
  publishFrame(frame: RenderedSurfaceFrame): void;
  publishAudio(audio: RenderedSurfaceAudio): void;
  /**
   * The decoded-state sidecar shown beside the canvas. Bounded model text may
   * cross here (ADR 0049); it is what an activity can show that a flat video
   * stream cannot.
   */
  publishOverlay(overlay: RenderedSurfaceOverlay): void;
  /** Present-tense work state shown while the next overlay is pending. */
  publishStatus(status: RenderedSurfaceStatus): void;
  /** Frames dropped because the producer socket was not open. Never silent. */
  readonly droppedFrameCount: number;
  /** PCM packets dropped while disconnected. */
  readonly droppedAudioPacketCount: number;
  readonly connected: boolean;
  close(): void;
}

const OPEN = 1;
const DEFAULT_RECONNECT_DELAY_MS = 2_000;

/**
 * Resolve the broker-owned bearer and build a sink, or return undefined when
 * the activity plane has never been bootstrapped. Deny-by-default: a runner
 * with no producer credential simply publishes nothing.
 */
export async function createBrokeredActivityFrameSink(
  options: Omit<ActivityFrameSinkOptions, "token">,
): Promise<ActivityFrameSink | undefined> {
  const token = await resolveActivityProducerCredential();
  if (token === undefined) return undefined;
  return createActivityFrameSink({ ...options, token });
}

export function createActivityFrameSink(options: ActivityFrameSinkOptions): ActivityFrameSink {
  const connect = options.connect ?? defaultConnect;
  const schedule = options.setTimeoutImpl ?? ((handler, ms) => setTimeout(handler, ms));
  const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;

  let socket: ActivityFrameSocket | null = null;
  let closed = false;
  let droppedFrames = 0;
  let droppedAudioPackets = 0;
  let latestStatus: RenderedSurfaceStatus | undefined;

  const open = (): void => {
    if (closed) return;
    const next = connect(options.url, options.token);
    socket = next;
    next.on("open", () => {
      if (socket !== next || latestStatus === undefined) return;
      try {
        next.send(JSON.stringify({ kind: "status", status: latestStatus }));
      } catch {
        // Latest-only state stays retained for the next reconnect.
      }
    });
    next.on("close", () => {
      socket = null;
      if (!closed) schedule(open, reconnectDelayMs);
    });
    next.on("error", () => next.close());
  };
  open();

  const send = (message: unknown, dropped: () => void): void => {
    if (socket === null || socket.readyState !== OPEN) {
      dropped();
      return;
    }
    try {
      socket.send(JSON.stringify(message));
    } catch {
      dropped();
    }
  };

  return {
    publishFrame(frame) {
      send({ kind: "frame", frame }, () => (droppedFrames += 1));
    },
    publishAudio(audio) {
      send({ kind: "audio", audio }, () => (droppedAudioPackets += 1));
    },
    publishOverlay(overlay) {
      send({ kind: "overlay", overlay }, () => undefined);
    },
    publishStatus(status) {
      latestStatus = status;
      send({ kind: "status", status }, () => undefined);
    },
    get droppedFrameCount() {
      return droppedFrames;
    },
    get droppedAudioPacketCount() {
      return droppedAudioPackets;
    },
    get connected() {
      return socket !== null && socket.readyState === OPEN;
    },
    close() {
      closed = true;
      socket?.close();
      socket = null;
      latestStatus = undefined;
    },
  };
}

function defaultConnect(url: string, token: string): ActivityFrameSocket {
  return new WebSocket(url, {
    headers: { authorization: `Bearer ${token}` },
  }) as unknown as ActivityFrameSocket;
}
