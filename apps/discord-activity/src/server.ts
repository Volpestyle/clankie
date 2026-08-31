import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { RenderedSurfaceHub } from "./frame-hub.ts";

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
}

export interface DiscordActivityServer {
  readonly server: Server;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export function createDiscordActivityServer(options: DiscordActivityServerOptions): DiscordActivityServer {
  const { hub } = options;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayloadBytes ?? 16 * 1024,
  });

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void serveRequest(request, response, options.avatarDirectory);
  });

  server.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
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
