import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { RenderedSurfaceHub } from "./frame-hub.ts";
import type { ActivityShareRegistry } from "./share-registry.ts";

const CLIENT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "client.html");

/**
 * Discord proxies every activity request through discordsays.com, and the
 * client must prefix its own requests with `/.proxy` or they are refused as
 * `blocked:csp`. The server therefore answers both the proxied and bare paths
 * so local development through a tunnel behaves the same as production.
 */
const FRAME_PATHS = new Set(["/.proxy/frames", "/frames"]);

export interface DiscordActivityServerOptions {
  hub: RenderedSurfaceHub;
  /** Host-baked persona PNGs Discord fetches through the public tunnel. */
  avatarDirectory?: string;
  /** Max inbound WebSocket payload. Viewers send little; this is a guard. */
  maxPayloadBytes?: number;
  shares?: ActivityShareRegistry;
  /** Unauthenticated sockets cannot hold an unbounded admission queue. */
  maxPendingViewers?: number;
  admissionTimeoutMs?: number;
}

export interface DiscordActivityServer {
  readonly server: Server;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export function createDiscordActivityServer(options: DiscordActivityServerOptions): DiscordActivityServer {
  const { hub } = options;
  const maxPendingViewers = bounded(options.maxPendingViewers ?? 64, 64);
  const admissionTimeoutMs = bounded(options.admissionTimeoutMs ?? 5_000, 5_000);
  let pendingViewers = 0;
  const maxPayload = bounded(options.maxPayloadBytes ?? 16 * 1024, 16 * 1024);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload,
  });

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void serveRequest(request, response, options.avatarDirectory);
  });

  server.on("upgrade", (request, socket, head) => {
    // Include rejected and closing sockets in the process-wide ceiling, not
    // only admitted viewers and sockets still awaiting their first message.
    if (wss.clients.size >= 8 * 64 + 64 + maxPendingViewers) {
      socket.destroy();
      return;
    }
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const share = /^\/(?:\.proxy\/)?shares\/([a-f0-9-]+)\/frames$/u.exec(path);
    if (share !== null && options.shares !== undefined) {
      if (pendingViewers >= maxPendingViewers) {
        socket.destroy();
        return;
      }
      pendingViewers += 1;
      let counted = true;
      const releasePending = () => {
        if (!counted) return;
        counted = false;
        pendingViewers -= 1;
      };
      // An invalid WebSocket handshake may never call handleUpgrade's
      // callback; its TCP close still releases the bounded admission slot.
      socket.once("close", releasePending);
      wss.handleUpgrade(request, socket, head, (ws) => {
        attachShareViewer(options.shares!, share[1]!, ws, admissionTimeoutMs, releasePending);
      });
      return;
    }
    if (!FRAME_PATHS.has(path)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      attachViewer(hub, ws);
    });
  });

  return {
    server,
    async listen(port, host = "127.0.0.1") {
      await new Promise<void>((resolveListen) => server.listen(port, host, resolveListen));
      const address = server.address();
      return typeof address === "object" && address !== null ? address.port : port;
    },
    async close() {
      hub.stop("session_ended");
      options.shares?.close();
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

function attachViewer(hub: RenderedSurfaceHub, socket: WebSocket): void {
  const viewer = {
    send: (payload: string) => socket.send(payload),
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    close: () => socket.close(),
  };
  if (!hub.addViewer(viewer)) return;
  socket.on("close", () => hub.removeViewer(viewer));
  socket.on("error", () => hub.removeViewer(viewer));
}

function attachShareViewer(
  shares: ActivityShareRegistry,
  shareId: string,
  socket: WebSocket,
  timeoutMs: number,
  releasePending: () => void,
): void {
  let pending = true;
  const viewer = {
    send: (payload: string) => socket.send(payload),
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    close: () => socket.close(),
  };
  const timer = setTimeout(() => {
    release();
    socket.close(4408, "admission_timeout");
  }, timeoutMs);
  timer.unref();
  function release(): void {
    if (!pending) return;
    pending = false;
    clearTimeout(timer);
    releasePending();
  }
  socket.on("message", (raw, isBinary) => {
    if (!pending) {
      socket.close(4403, "viewer_is_read_only");
      return;
    }
    release();
    let body: unknown;
    try {
      body = JSON.parse(raw.toString());
    } catch {
      body = null;
    }
    if (
      isBinary ||
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 2 ||
      !("kind" in body) ||
      body.kind !== "admit" ||
      !("grant" in body) ||
      typeof body.grant !== "string" ||
      body.grant.length > 128 ||
      !shares.admit(shareId, body.grant, viewer)
    ) {
      socket.close(4403, "admission_denied");
    }
  });
  const cleanup = () => {
    release();
    shares.removeViewer(shareId, viewer);
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
}

function bounded(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error("invalid_viewer_limit");
  return value;
}

async function serveRequest(
  request: IncomingMessage,
  response: ServerResponse,
  avatarDirectory: string | undefined,
): Promise<void> {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const avatar =
    /^\/(?:\.proxy\/)?avatars\/(agent-(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})-[a-f0-9]{64})\.png$/u.exec(
      path,
    );
  if (avatar !== null && avatarDirectory !== undefined) {
    try {
      const image = await readFile(join(avatarDirectory, `${avatar[1]}.png`));
      response
        .writeHead(200, {
          "content-type": "image/png",
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        })
        .end(image);
    } catch {
      response.writeHead(404).end();
    }
    return;
  }
  if (path !== "/" && path !== "/.proxy/" && path !== "/index.html") {
    response.writeHead(404).end();
    return;
  }
  try {
    const html = await readFile(CLIENT_PATH, "utf8");
    response
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      })
      .end(html);
  } catch {
    response.writeHead(500).end();
  }
}
