import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PLAY_UTTERANCE_MAX_CHARS,
  PLAY_VOICE_DEFAULT_PORT,
  PLAY_VOICE_PATH,
  PLAY_VOICE_SCHEMA_VERSION,
  PlayClientMessageSchema,
  PlayUtteranceSchema,
  type PlayRoom,
} from "./protocol.ts";

/**
 * The gateway-holding side of Clankie's play voice seam (ADR 0064).
 *
 * Hosted by whichever media-enabled process owns the active Discord body.
 * It binds loopback only: play is local/hosted by construction, and
 * an inbound path that could be reached off-box would be a way to speak as
 * Clankie without holding his gateway. The bearer is the second lock, not the
 * only one, exactly as with the activity producer listener.
 */
export interface PlayVoiceListenerOptions {
  /** Broker-minted bearer play presents. Absent means the seam stays closed. */
  token: string;
  /**
   * Hand play's report to the live voice session. Rejecting is normal
   * and expected — he may not be in a voice channel — and the reason travels
   * back to play rather than being swallowed.
   */
  narrate: (
    text: string,
    options: { readonly deliveryId: string; readonly respond: boolean },
  ) => Promise<void>;
  /**
   * Whether anyone can currently hear the body, read at attach time so a
   * play client that connects mid-call learns the room without waiting for the
   * next change. Absent means "no room", which is the safe default: the
   * play loop keeps authoring for its own surfaces (ADR 0074).
   */
  room?: () => PlayRoomState;
  /** Content-free seam evidence for the bridge receipt log; never carries text. */
  emit?: (evidence: PlayVoiceListenerEvidence) => void | Promise<void>;
  /** Injected by tests so delivery ids stay deterministic. */
  idFactory?: () => string;
  maxPayloadBytes?: number;
}

/** Whether anyone can hear the body — never who. */
export interface PlayRoomState {
  readonly listening: boolean;
}

export type PlayVoiceListenerEvidence =
  | {
      readonly type: "play_connection";
      readonly phase: "attached" | "detached";
      readonly attachedCount: number;
      readonly stayId?: string;
    }
  | {
      readonly type: "play_room";
      readonly listening: boolean;
      readonly attachedCount: number;
      readonly deliveredCount: number;
      readonly stayId?: string;
    }
  | {
      readonly type: "play_transcript_delivery";
      readonly deliveryId: string;
      readonly attachedCount: number;
      readonly deliveredCount: number;
      readonly stayId?: string;
    }
  | {
      readonly type: "play_narration_submission";
      readonly deliveryId: string;
      readonly attachedCount: number;
      readonly stayId?: string;
    }
  | {
      readonly type: "play_refusal";
      readonly deliveryId: string;
      readonly attachedCount: number;
      readonly reason: string;
      readonly stayId?: string;
    };

export interface PlayVoiceListener {
  readonly server: Server;
  listen(port: number): Promise<number>;
  /** Push one transcript line to every attached play client. Never retained here. */
  publishUtterance(text: string): void;
  /**
   * Push the room's listening state to every attached play client. The Discord body
   * calls this on every presence change so a play loop learns it has an
   * audience — or lost one — at the turn boundary rather than a call later.
   */
  publishRoom(state: PlayRoomState): void;
  readonly attachedCount: number;
  close(): Promise<void>;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
const OPEN = 1;

/**
 * Create the loopback listener, bind it, and forward transcript lines into it.
 * Both Discord bodies host this the same way; stay-id stitching stays in emit.
 */
export async function startPlayVoiceListener(
  options: PlayVoiceListenerOptions & {
    subscribeTranscript: (onLine: (line: string) => void) => () => void;
    port?: number;
  },
): Promise<{ listener: PlayVoiceListener; stopTranscript: () => void; port: number }> {
  const listener = createPlayVoiceListener(options);
  const port = await listener.listen(options.port ?? PLAY_VOICE_DEFAULT_PORT);
  const stopTranscript = options.subscribeTranscript((line) => listener.publishUtterance(line));
  return { listener, stopTranscript, port };
}

export function createPlayVoiceListener(options: PlayVoiceListenerOptions): PlayVoiceListener {
  if (options.token.trim().length === 0) {
    throw new Error("play_voice_token_required");
  }
  const { token, narrate } = options;
  const readRoom = options.room;
  const emit = options.emit;
  const idFactory = options.idFactory ?? randomUUID;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
  });
  const attached = new Set<WebSocket>();

  const server = createServer((_request, response) => {
    // The play listener serves no content at all.
    response.writeHead(404).end();
  });

  const emitSafely = (evidence: PlayVoiceListenerEvidence): void => {
    if (emit === undefined) return;
    void Promise.resolve()
      .then(() => emit(evidence))
      .catch(() => undefined);
  };

  const sendTo = (ws: WebSocket, payload: string): boolean => {
    if (ws.readyState !== OPEN) return false;
    try {
      ws.send(payload);
      return true;
    } catch {
      // A play client that cannot be reached simply misses this message. The
      // room does not wait for it and nothing is queued on its behalf.
      return false;
    }
  };

  const broadcast = (payload: string): number => {
    let deliveredCount = 0;
    for (const ws of attached) {
      if (sendTo(ws, payload)) deliveredCount += 1;
    }
    return deliveredCount;
  };

  const broadcastConfirmed = (payload: string, complete: (deliveredCount: number) => void): void => {
    const recipients = [...attached].filter((ws) => ws.readyState === OPEN);
    if (recipients.length === 0) {
      complete(0);
      return;
    }
    let remaining = recipients.length;
    let deliveredCount = 0;
    const settled = (delivered: boolean): void => {
      if (delivered) deliveredCount += 1;
      remaining -= 1;
      if (remaining === 0) complete(deliveredCount);
    };
    for (const ws of recipients) {
      try {
        ws.send(payload, (error) => settled(error === undefined || error === null));
      } catch {
        settled(false);
      }
    }
  };

  const publishRoomTo = (ws: WebSocket, state: PlayRoomState): void => {
    const deliveredCount = sendTo(ws, roomPayload(state)) ? 1 : 0;
    emitSafely({
      type: "play_room",
      listening: state.listening,
      attachedCount: attached.size,
      deliveredCount,
    });
  };

  server.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== PLAY_VOICE_PATH || !authorized(request, token)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      attached.add(ws);
      emitSafely({ type: "play_connection", phase: "attached", attachedCount: attached.size });
      // The room as it is right now, not as it will be at the next change: a
      // play attaching mid-call would otherwise spend the rest of the
      // call believing nobody is listening.
      if (readRoom !== undefined) publishRoomTo(ws, readRoom());
      ws.on("close", () => {
        attached.delete(ws);
        emitSafely({ type: "play_connection", phase: "detached", attachedCount: attached.size });
      });
      ws.on("error", () => ws.close());
      ws.on("message", (raw) => {
        const parsed = PlayClientMessageSchema.safeParse(safeJson(raw.toString()));
        if (!parsed.success) return;
        const deliveryId = parsed.data.deliveryId ?? idFactory();
        // Fire-and-forget on purpose: narration is an utterance in a live room,
        // not a request/response. A failure is reported through the bridge's own
        // evidence, and a client that waited on it would stall its play loop.
        void narrate(parsed.data.text, { deliveryId, respond: parsed.data.respond ?? true })
          .then(() => {
            // A submission receipt means the live persona accepted the event,
            // not merely that the listener attempted the call. Keeping it
            // after resolution prevents refused narration from proving the
            // two-way seam.
            emitSafely({
              type: "play_narration_submission",
              deliveryId,
              attachedCount: attached.size,
            });
          })
          .catch((error: unknown) => {
            emitSafely({
              type: "play_refusal",
              deliveryId,
              attachedCount: attached.size,
              reason: refusalReason(error),
            });
          });
      });
    });
  });

  return {
    server,
    async listen(port) {
      // Loopback only. This must never bind a routable interface.
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        try {
          server.listen(port, "127.0.0.1");
        } catch (error) {
          server.off("error", onError);
          server.off("listening", onListening);
          reject(error);
        }
      });
      const address = server.address();
      return typeof address === "object" && address !== null ? address.port : port;
    },
    publishUtterance(text) {
      const bounded = boundedUtteranceText(text);
      if (bounded === undefined) return;
      const message = PlayUtteranceSchema.safeParse({
        schemaVersion: PLAY_VOICE_SCHEMA_VERSION,
        type: "utterance",
        text: bounded,
      });
      if (!message.success) return;
      const deliveryId = idFactory();
      const attachedCount = attached.size;
      broadcastConfirmed(JSON.stringify(message.data), (deliveredCount) => {
        emitSafely({
          type: "play_transcript_delivery",
          deliveryId,
          attachedCount,
          deliveredCount,
        });
      });
    },
    publishRoom(state) {
      const deliveredCount = broadcast(roomPayload(state));
      emitSafely({
        type: "play_room",
        listening: state.listening,
        attachedCount: attached.size,
        deliveredCount,
      });
    },
    get attachedCount() {
      return attached.size;
    },
    async close() {
      for (const ws of attached) ws.close();
      attached.clear();
      wss.close();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

function boundedUtteranceText(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  let end = Math.min(trimmed.length, PLAY_UTTERANCE_MAX_CHARS);
  if (
    end < trimmed.length &&
    end > 0 &&
    /[\uD800-\uDBFF]/u.test(trimmed[end - 1] ?? "") &&
    /[\uDC00-\uDFFF]/u.test(trimmed[end] ?? "")
  ) {
    end -= 1;
  }
  return trimmed.slice(0, end);
}

function roomPayload(state: PlayRoomState): string {
  const message: PlayRoom = {
    schemaVersion: PLAY_VOICE_SCHEMA_VERSION,
    type: "room",
    listening: state.listening,
  };
  return JSON.stringify(message);
}

function refusalReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const token = raw.trim().split(/[:\s]/u)[0]?.toLowerCase() ?? "";
  const normalized = token
    .replace(/[^a-z0-9_]/gu, "_")
    .replace(/_+/gu, "_")
    .slice(0, 64);
  return /^[a-z0-9_]{1,64}$/u.test(normalized) ? normalized : "play_narration_refused";
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  // Compare lengths first: timingSafeEqual throws on a length mismatch.
  if (presented.byteLength !== expected.byteLength) return false;
  return timingSafeEqual(presented, expected);
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
