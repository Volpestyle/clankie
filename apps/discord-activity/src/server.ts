import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { RenderedSurfaceHub } from "./frame-hub.ts";
import type { ActivityShareRegistry } from "./share-registry.ts";

const CLIENT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "client.html");
const BUNDLE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/activity-client.js");

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
  /** One client cannot take the whole admission queue for itself. */
  maxPendingViewersPerClient?: number;
  admissionTimeoutMs?: number;
  /**
   * Viewers arrive through share grants by default. Official hosting adds the
   * Discord SDK admission. `local` is an explicit development mode that opens
   * the legacy unauthenticated `/frames` stream, and only to a direct loopback
   * request: a tunnelled, proxied or cross-origin request still needs a grant.
   */
  viewerMode?: { mode: "official"; applicationId: string } | { mode: "local" };
}

export interface DiscordActivityServer {
  readonly server: Server;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export function createDiscordActivityServer(options: DiscordActivityServerOptions): DiscordActivityServer {
  const { hub } = options;
  const maxPendingViewers = bounded(options.maxPendingViewers ?? 64, 64);
  const maxPendingPerClient = bounded(
    options.maxPendingViewersPerClient ?? Math.min(4, maxPendingViewers),
    maxPendingViewers,
  );
  const admissionTimeoutMs = bounded(options.admissionTimeoutMs ?? 5_000, 5_000);
  let pendingViewers = 0;
  const pendingByClient = new Map<string, number>();
  const maxPayload = bounded(options.maxPayloadBytes ?? 16 * 1024, 16 * 1024);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload,
  });

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void serveRequest(request, response, options);
  });

  server.on("upgrade", (request, socket, head) => {
    // Include rejected and closing sockets in the process-wide ceiling, not
    // only admitted viewers and sockets still awaiting their first message.
    if (wss.clients.size >= 8 * 64 + 64 + maxPendingViewers) {
      socket.destroy();
      return;
    }
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const share = /^\/(?:\.proxy\/)?(?:activity\/)?shares\/([a-f0-9-]+)\/frames$/u.exec(path);
    if (share !== null && options.shares !== undefined) {
      const client = clientKey(request);
      const clientPending = pendingByClient.get(client) ?? 0;
      if (pendingViewers >= maxPendingViewers || clientPending >= maxPendingPerClient) {
        socket.destroy();
        return;
      }
      pendingViewers += 1;
      pendingByClient.set(client, clientPending + 1);
      let counted = true;
      const releasePending = () => {
        if (!counted) return;
        counted = false;
        pendingViewers -= 1;
        const remaining = (pendingByClient.get(client) ?? 1) - 1;
        if (remaining > 0) pendingByClient.set(client, remaining);
        else pendingByClient.delete(client);
      };
      // An invalid WebSocket handshake may never call handleUpgrade's
      // callback; its TCP close still releases the bounded admission slot.
      socket.once("close", releasePending);
      wss.handleUpgrade(request, socket, head, (ws) => {
        attachShareViewer(options.shares!, share[1]!, ws, admissionTimeoutMs, releasePending);
      });
      return;
    }
    if (!FRAME_PATHS.has(path) || effectiveViewerMode(options, request).mode !== "local") {
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
    close: () => socket.close(4403, "admission_ended"),
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

type EffectiveViewerMode =
  | { mode: "official"; applicationId: string }
  | { mode: "local" }
  | { mode: "shares" };

function effectiveViewerMode(
  options: DiscordActivityServerOptions,
  request: IncomingMessage,
): EffectiveViewerMode {
  const mode = options.viewerMode;
  if (mode?.mode === "official") return mode;
  if (mode?.mode === "local" && isDirectLoopbackRequest(request)) return mode;
  return { mode: "shares" };
}

/**
 * Headers a reverse proxy or tunnel adds. cloudflared connects from loopback,
 * so the peer address alone cannot tell a tunnelled viewer from a local one.
 */
const FORWARDING_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "true-client-ip",
  "cf-connecting-ip",
  "cf-ray",
  "cf-visitor",
];

function isDirectLoopbackRequest(request: IncomingMessage): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false;
  if (FORWARDING_HEADERS.some((name) => request.headers[name] !== undefined)) return false;
  if (!isLoopbackHostname(hostnameOf(`http://${request.headers.host ?? ""}`))) return false;
  // A browser page on another site may open a loopback WebSocket; its Origin says so.
  const origin = request.headers.origin;
  return origin === undefined || isLoopbackHostname(hostnameOf(origin));
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname: string | undefined): boolean {
  if (hostname === undefined) return false;
  return hostname === "localhost" || hostname === "[::1]" || isLoopbackAddress(hostname);
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  return v4 === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(v4);
}

/** Behind the tunnel every peer is loopback; Cloudflare names the real client. */
function clientKey(request: IncomingMessage): string {
  const forwarded = request.headers["cf-connecting-ip"];
  return typeof forwarded === "string" && forwarded.length > 0 && forwarded.length <= 64
    ? `cf:${forwarded}`
    : `peer:${request.socket.remoteAddress ?? "unknown"}`;
}

function bounded(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error("invalid_viewer_limit");
  return value;
}

async function serveRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: DiscordActivityServerOptions,
): Promise<void> {
  const { avatarDirectory } = options;
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (request.method === "GET" && (path === "/activity/config" || path === "/.proxy/activity/config")) {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(effectiveViewerMode(options, request)));
    return;
  }
  if (request.method === "GET" && (path === "/activity-client.js" || path === "/.proxy/activity-client.js")) {
    try {
      const script = await readFile(BUNDLE_PATH);
      response
        .writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-cache",
          "x-content-type-options": "nosniff",
        })
        .end(script);
    } catch {
      response.writeHead(503).end();
    }
    return;
  }
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
