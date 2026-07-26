import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  POSSESSOR_VOICE_PATH,
  POSSESSOR_VOICE_SCHEMA_VERSION,
  PossessorClientMessageSchema,
  type PossessorUtterance,
} from "./protocol.ts";

/**
 * The gateway-holding side of the possessor voice seam (ADR 0064).
 *
 * Hosted by whichever process owns the body in Discord — today the bot bridge.
 * It binds loopback only: a possessor is a local process by construction, and
 * an inbound path that could be reached off-box would be a way to speak as
 * Clankie without holding his gateway. The bearer is the second lock, not the
 * only one, exactly as with the activity producer listener.
 */
export interface PossessorVoiceListenerOptions {
  /** Broker-minted bearer the possessor presents. Absent means the seam stays closed. */
  token: string;
  /**
   * Hand the possessor's report to the live voice session. Rejecting is normal
   * and expected — he may not be in a voice channel — and the reason travels
   * back to the possessor rather than being swallowed.
   */
  narrate: (text: string) => Promise<void>;
  maxPayloadBytes?: number;
}

export interface PossessorVoiceListener {
  readonly server: Server;
  listen(port: number): Promise<number>;
  /** Push one transcript line to every attached possessor. Never retained here. */
  publishUtterance(text: string): void;
  readonly attachedCount: number;
  close(): Promise<void>;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
const OPEN = 1;

export function createPossessorVoiceListener(options: PossessorVoiceListenerOptions): PossessorVoiceListener {
  if (options.token.trim().length === 0) {
    throw new Error("possessor_voice_token_required");
  }
  const { token, narrate } = options;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
  });
  const attached = new Set<WebSocket>();

  const server = createServer((_request, response) => {
    // The possessor listener serves no content at all.
    response.writeHead(404).end();
  });

  server.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== POSSESSOR_VOICE_PATH || !authorized(request, token)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      attached.add(ws);
      ws.on("close", () => attached.delete(ws));
      ws.on("error", () => ws.close());
      ws.on("message", (raw) => {
        const parsed = PossessorClientMessageSchema.safeParse(safeJson(raw.toString()));
        if (!parsed.success) return;
        // Fire-and-forget on purpose: narration is an utterance in a live room,
        // not a request/response. A failure is reported through the bridge's own
        // evidence, and a possessor that waited on it would stall its play loop.
        void narrate(parsed.data.text).catch(() => undefined);
      });
    });
  });

  return {
    server,
    async listen(port) {
      // Loopback only. This must never bind a routable interface.
      await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
      const address = server.address();
      return typeof address === "object" && address !== null ? address.port : port;
    },
    publishUtterance(text) {
      const trimmed = text.trim();
      if (trimmed.length === 0 || attached.size === 0) return;
      const message: PossessorUtterance = {
        schemaVersion: POSSESSOR_VOICE_SCHEMA_VERSION,
        type: "utterance",
        text: trimmed,
      };
      const payload = JSON.stringify(message);
      for (const ws of attached) {
        if (ws.readyState !== OPEN) continue;
        try {
          ws.send(payload);
        } catch {
          // A possessor that cannot be reached simply misses this line. The
          // room does not wait for it and nothing is queued on its behalf.
        }
      }
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
