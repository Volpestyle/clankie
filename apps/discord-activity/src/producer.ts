import { RenderedSurfaceMessageSchema } from "@clankie/interactive-environment";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { RenderedSurfaceHub } from "./frame-hub.ts";

/**
 * Ingress for the host that actually owns the emulator (ADR 0047).
 *
 * This listener is deliberately **separate from the viewer server**. The viewer
 * server is tunnelled and reachable through Discord's `discordsays.com` proxy;
 * a producer path mounted on it would be reachable by anyone who can reach the
 * activity. Binding the producer on loopback keeps frame injection off the
 * public surface entirely, and the bearer token is the second lock rather than
 * the only one.
 */
export interface FrameProducerServerOptions {
  hub: RenderedSurfaceHub;
  /** Shared secret the frame producer presents. Absent means the endpoint stays closed. */
  token: string;
  /** Producer frames are bounded by the transport contract; this is the guard. */
  maxPayloadBytes?: number;
}

export interface FrameProducerServer {
  readonly server: Server;
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 512 * 1024;

export function createFrameProducerServer(options: FrameProducerServerOptions): FrameProducerServer {
  if (options.token.trim().length === 0) {
    throw new Error("activity_producer_token_required");
  }
  const { hub, token } = options;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
  });

  const server = createServer((_request, response) => {
    // The producer listener serves no content at all.
    response.writeHead(404).end();
  });

  // The newest authenticated producer owns the session. A runner reconnect
  // can race its dying socket's close, so a superseded socket must be unable
  // to stop or mutate the session it no longer owns.
  let current: WebSocket | null = null;

  server.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== "/producer" || !authorized(request, token)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const previous = current;
      current = ws;
      previous?.close();
      ws.on("message", (raw) => {
        if (current !== ws) return;
        // The producer is trusted but still validated: a malformed frame must
        // not reach viewers, and byteLength/digest are checked by the schema.
        const parsed = RenderedSurfaceMessageSchema.safeParse(safeJson(raw.toString()));
        if (!parsed.success) return;
        if (parsed.data.kind === "frame") hub.publishFrame(parsed.data.frame);
        else if (parsed.data.kind === "overlay") hub.publishOverlay(parsed.data.overlay);
        else hub.stop(parsed.data.reason);
      });
      // A live-only surface must not relabel its last frame as current after
      // the producer exits or crashes. Disconnect invalidates the snapshot —
      // but only when the closing socket still owns the session.
      ws.on("close", () => {
        if (current !== ws) return;
        current = null;
        hub.stop("session_ended");
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
    async close() {
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
