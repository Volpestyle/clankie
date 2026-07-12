import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { RelayHub } from "./hub.ts";
import { RelayEnvelopeSchema, RelayHelloSchema, type RelayHello } from "./protocol.ts";

const port = Number(process.env.PORT ?? 4320);
const developmentToken = process.env.CLANKIE_RELAY_DEV_TOKEN;
if (!developmentToken || developmentToken.length < 16) {
  throw new Error(
    "CLANKIE_RELAY_DEV_TOKEN must be at least 16 characters. This shared token is development-only.",
  );
}

const hub = new RelayHub();
const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, ...hub.snapshot() }));
    return;
  }
  response.statusCode = 404;
  response.end("Not found");
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
        if (hello.token !== developmentToken) {
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

server.listen(port, "127.0.0.1", () => {
  console.log(`Development relay listening on ws://127.0.0.1:${port}`);
});
