import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { RelayHub } from "./hub.ts";
import { RelayEnvelopeSchema, RelayHelloSchema, type RelayHello } from "./protocol.ts";
import { ControlPlaneDeviceAuthorizer } from "./device-auth.ts";
import { createCaptainConversationDispatch } from "./conversation-upstream.ts";
import {
  createOperatorConversationRelayHandler,
  type RelayConversationLogger,
} from "./operator-conversations.ts";

const port = Number(process.env.PORT ?? 4320);
const host = process.env.CLANKIE_RELAY_HOST ?? "127.0.0.1";
const developmentToken = process.env.CLANKIE_RELAY_DEV_TOKEN;
if (developmentToken !== undefined && developmentToken.length < 16) {
  throw new Error(
    "CLANKIE_RELAY_DEV_TOKEN must be at least 16 characters. This shared token is development-only.",
  );
}

const hub = new RelayHub();
const captainToken = process.env.CLANKIE_CAPTAIN_TOKEN;
const conversationLogger: RelayConversationLogger = {
  info: (fields, message) => console.log(JSON.stringify({ level: "info", ...fields, message })),
  warn: (fields, message) => console.warn(JSON.stringify({ level: "warn", ...fields, message })),
};
const conversationHandler = createOperatorConversationRelayHandler({
  authorizeDevice: new ControlPlaneDeviceAuthorizer({
    baseUrl: process.env.CLANKIE_CONTROL_PLANE_URL ?? "http://127.0.0.1:4310",
  }),
  dispatch:
    captainToken === undefined
      ? async () => {
          throw new Error("Captain conversation authentication is unavailable");
        }
      : createCaptainConversationDispatch({
          baseUrl: process.env.CLANKIE_CAPTAIN_URL ?? "http://127.0.0.1:4321",
          bearerToken: captainToken,
        }),
  logger: conversationLogger,
});
const server = createServer((request, response) => {
  void handleHttp(request, response);
});
const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });

wss.on("connection", (socket) => handleSocket(socket));

function handleSocket(socket: WebSocket): void {
  let identity: RelayHello | undefined;
  let unregister: (() => void) | undefined;
  const helloTimeout = setTimeout(() => socket.close(4000, "hello required"), 5_000);

  socket.on("message", (bytes) => {
    try {
      const parsed: unknown = JSON.parse(bytes.toString());
      if (!identity) {
        const hello = RelayHelloSchema.parse(parsed);
        if (developmentToken === undefined || hello.token !== developmentToken) {
          socket.close(4003, "unauthorized");
          return;
        }
        identity = hello;
        unregister = hub.register(socket, hello);
        clearTimeout(helloTimeout);
        socket.send(JSON.stringify({ type: "hello.accepted", workspaceId: hello.workspaceId }));
        return;
      }
      const envelope = RelayEnvelopeSchema.parse(parsed);
      hub.route(identity, envelope);
    } catch (error) {
      socket.send(
        JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) }),
      );
    }
  });
  socket.on("close", () => {
    clearTimeout(helloTimeout);
    unregister?.();
  });
}

server.listen(port, host, () => {
  console.log(`Relay listening on http://${host}:${port}`);
});

async function handleHttp(
  request: Parameters<typeof conversationHandler>[0],
  response: Parameters<typeof conversationHandler>[1],
): Promise<void> {
  if (request.url === "/health") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, ...hub.snapshot() }));
    return;
  }
  try {
    if (await conversationHandler(request, response)) return;
  } catch {
    if (!response.headersSent) response.statusCode = 500;
    if (!response.writableEnded) response.end(JSON.stringify({ error: "relay_internal_error" }));
    return;
  }
  response.statusCode = 404;
  response.end("Not found");
}
