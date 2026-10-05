import {
  ActivityShareProducerMessageSchema,
  RenderedSurfaceMessageSchema,
  type ActivityShareScope,
  type ActivityShareSource,
} from "@clankie/interactive-environment";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WebSocketServer, type WebSocket } from "ws";
import type { RenderedSurfaceHub } from "./frame-hub.ts";
import { ActivityShareError, type ActivityShareRegistry } from "./share-registry.ts";

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
  shares?: ActivityShareRegistry;
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
  const maxPayload = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  if (!Number.isSafeInteger(maxPayload) || maxPayload <= 0 || maxPayload > DEFAULT_MAX_PAYLOAD_BYTES) {
    throw new Error("invalid_producer_payload_limit");
  }
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload,
  });

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/shares" || path.startsWith("/shares/")) {
      void handleShareControl(request, response, path, options);
      return;
    }
    if (request.method === "GET" && path === "/snapshot") {
      if (!authorized(request, token)) {
        response.writeHead(401).end();
        return;
      }
      const frame = hub.snapshot();
      if (frame === null) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(frame));
      return;
    }
    response.writeHead(404).end();
  });

  // The newest authenticated producer owns the session. A runner reconnect
  // can race its dying socket's close, so a superseded socket must be unable
  // to stop or mutate the session it no longer owns.
  let current: WebSocket | null = null;

  server.on("upgrade", (request, socket, head) => {
    // Eight scoped producers, one legacy producer, and a bounded number of
    // rejected/closing connections. Closing handshakes do not grow forever.
    if (wss.clients.size >= 16) {
      socket.destroy();
      return;
    }
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const share = /^\/shares\/([a-f0-9-]+)\/producer$/u.exec(path);
    if (share !== null && options.shares !== undefined) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.on("error", () => undefined);
        let lease;
        try {
          lease = options.shares!.acquireProducer(share[1]!, bearer(request), { close: () => ws.close() });
        } catch (error) {
          ws.close(error instanceof ActivityShareError && error.status === 409 ? 4409 : 4403);
          return;
        }
        ws.on("message", (raw) => {
          const parsed = ActivityShareProducerMessageSchema.safeParse(safeJson(raw.toString()));
          if (parsed.success) lease.publish(parsed.data);
        });
        ws.on("close", () => lease.disconnect());
        ws.on("error", () => lease.disconnect());
      });
      return;
    }
    if (path !== "/producer" || !authorized(request, token)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const previous = current;
      current = ws;
      if (previous !== null) hub.beginSession();
      previous?.close();
      ws.on("message", (raw) => {
        if (current !== ws) return;
        // The producer is trusted but still validated: a malformed frame must
        // not reach viewers. The legacy schema checks its byte count; the
        // scoped v2 protocol additionally checks PNG dimensions and digest.
        const parsed = RenderedSurfaceMessageSchema.safeParse(safeJson(raw.toString()));
        if (!parsed.success) return;
        if (parsed.data.kind === "frame") hub.publishFrame(parsed.data.frame);
        else if (parsed.data.kind === "audio") hub.publishAudio(parsed.data.audio);
        else if (parsed.data.kind === "overlay") hub.publishOverlay(parsed.data.overlay);
        else if (parsed.data.kind === "status") hub.publishStatus(parsed.data.status);
        else {
          // Stop ends this producer's authority before clearing the hub. A
          // frame already queued behind it cannot repopulate the snapshot.
          current = null;
          hub.stop(parsed.data.reason);
          ws.close();
        }
      });
      // A live-only surface must not relabel its last frame as current after
      // the producer exits or crashes. Disconnect invalidates the snapshot —
      // but only when the closing socket still owns the session.
      ws.on("close", () => {
        if (current !== ws) return;
        current = null;
        hub.stop("session_ended");
      });
      ws.on("error", () => {
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
      options.shares?.close();
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

function authorized(request: IncomingMessage, token: string): boolean {
  const presented = Buffer.from(bearer(request));
  const expected = Buffer.from(token);
  // Compare lengths first: timingSafeEqual throws on a length mismatch.
  if (presented.byteLength !== expected.byteLength) return false;
  return timingSafeEqual(presented, expected);
}

function bearer(request: IncomingMessage): string {
  const header = request.headers.authorization;
  return typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

async function handleShareControl(
  request: IncomingMessage,
  response: import("node:http").ServerResponse,
  path: string,
  options: FrameProducerServerOptions,
): Promise<void> {
  if (!authorized(request, options.token)) {
    response.writeHead(401).end();
    return;
  }
  if (options.shares === undefined) {
    response.writeHead(404).end();
    return;
  }
  try {
    if (request.method === "GET" && path === "/shares") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(options.shares.list()));
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    const action = /^\/shares\/([a-f0-9-]+)\/(switch|grant|stop|viewer)$/u.exec(path);
    if (path !== "/shares" && action === null) {
      response.writeHead(404).end();
      return;
    }
    const body = await readControlBody(request);
    let result: unknown;
    if (path === "/shares") {
      exactKeys(body, ["scope", "source", "ttlMs"]);
      result = options.shares.create(
        body.scope as ActivityShareScope,
        body.source as ActivityShareSource,
        optionalNumber(body.ttlMs),
      );
    } else {
      const shareId = action![1]!;
      const kind = action![2];
      exactKeys(
        body,
        kind === "viewer"
          ? body.mode === "live"
            ? ["generation", "mode"]
            : ["generation", "grant"]
          : kind === "switch"
            ? ["generation", "source"]
            : kind === "grant"
              ? ["generation", "ttlMs"]
              : ["generation"],
      );
      const generation = optionalNumber(body.generation) ?? 0;
      if (kind === "viewer") {
        if (body.mode !== "live" && (typeof body.grant !== "string" || body.grant.length > 128)) {
          throw new ActivityShareError("admission_denied", 403);
        }
        const stream =
          body.mode === "live"
            ? options.shares.openViewerFromController(shareId, generation)
            : options.shares.openViewer(shareId, generation, body.grant as string);
        response.writeHead(200, {
          "content-type": "application/x-ndjson",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        // Node's pipeline honors HTTP backpressure and cancels the registry
        // stream when the audience gateway disconnects or revokes access.
        await pipeline(Readable.fromWeb(stream), response).catch(() => undefined);
        return;
      }
      result =
        kind === "switch"
          ? options.shares.switch(shareId, generation, body.source as ActivityShareSource)
          : kind === "grant"
            ? options.shares.grant(shareId, generation, optionalNumber(body.ttlMs))
            : options.shares.stop(shareId, generation);
    }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(error instanceof ActivityShareError ? error.status : 500, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(
      JSON.stringify({ error: error instanceof ActivityShareError ? error.code : "share_control_failed" }),
    );
    if (error instanceof ActivityShareError && error.status === 413) {
      response.once("finish", () => request.destroy());
    }
  }
}

function readControlBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024) {
        request.pause();
        reject(new ActivityShareError("control_payload_too_large", 413));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const body = safeJson(Buffer.concat(chunks).toString());
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        reject(new ActivityShareError("invalid_control_payload", 400));
      } else resolve(body as Record<string, unknown>);
    });
    request.on("error", reject);
    request.on("aborted", () => reject(new ActivityShareError("control_request_aborted", 400)));
  });
}

function exactKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    throw new ActivityShareError("invalid_control_payload", 400);
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new ActivityShareError("invalid_control_payload", 400);
  return value;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
