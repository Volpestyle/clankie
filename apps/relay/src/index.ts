import { createServer } from "node:http";
import { ControlPlaneDeviceAuthorizer } from "./device-auth.ts";
import { createCaptainConversationDispatch } from "./conversation-upstream.ts";
import {
  createOperatorConversationRelayHandler,
  type RelayConversationLogger,
} from "./operator-conversations.ts";

// 4320 belongs to the activity surface; the relay's canonical port is 4321.
const port = Number(process.env.CLANKIE_RELAY_PORT ?? process.env.PORT ?? 4321);
const host = process.env.CLANKIE_RELAY_HOST ?? "127.0.0.1";

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
          baseUrl: process.env.CLANKIE_CAPTAIN_URL ?? "http://127.0.0.1:4310",
          bearerToken: captainToken,
        }),
  logger: conversationLogger,
});
const server = createServer((request, response) => {
  void handleHttp(request, response);
});

server.listen(port, host, () => {
  console.log(`Relay listening on http://${host}:${port}`);
});

async function handleHttp(
  request: Parameters<typeof conversationHandler>[0],
  response: Parameters<typeof conversationHandler>[1],
): Promise<void> {
  if (request.url === "/health") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
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
