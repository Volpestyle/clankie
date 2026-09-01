import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  PUBLIC_GATEWAY_HOST_CONNECT_PATH,
  PUBLIC_GATEWAY_SCHEMA_VERSION,
  PublicGatewayTunnelFrameSchema,
  type PublicGatewayPairingRouteFrame,
  type PublicGatewayResponseChunkFrame,
  type PublicGatewayTunnelFrame,
} from "@clankie/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { PublicGatewayConnector } from "../src/public-gateway-connector.ts";

const hostId = "mac_james_12345678";
const hostToken = "gateway-host-token-that-is-longer-than-thirty-two-characters";
const servers: Server[] = [];
const connectors: PublicGatewayConnector[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const connector of connectors.splice(0)) connector.close();
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("public gateway Mac connector", () => {
  it("registers hashed offers and forwards bounded relay responses", async () => {
    const relayRequests: Array<{ readonly authorization?: string; readonly body: string }> = [];
    const relay = await listen(
      createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk.toString();
        relayRequests.push({
          ...(request.headers.authorization === undefined
            ? {}
            : { authorization: request.headers.authorization }),
          body,
        });
        response.setHeader("content-type", "application/x-ndjson");
        response.write('{"kind":"event"}\n');
        response.end('{"kind":"done"}\n');
      }),
    );
    const control = await listen(createServer((_request, response) => response.end("{}")));
    const gateway = await fakeGateway();
    const logs: Array<{ readonly fields: Readonly<Record<string, unknown>>; readonly message: string }> = [];
    const connector = new PublicGatewayConnector({
      gatewayUrl: gateway.origin,
      hostId,
      hostToken,
      controlPlaneUrl: control,
      relayUrl: relay,
      logger: {
        info: (fields, message) => logs.push({ fields, message }),
        warn: (fields, message) => logs.push({ fields, message }),
      },
      reconnectMinimumMs: 5,
      reconnectMaximumMs: 10,
    });
    connectors.push(connector);
    connector.start();

    await connector.publishPairingOffer({
      offerSecret: "high-entropy-offer-secret",
      code: "7F3K-M2QT",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const connection = await gateway.nextConnection();
    expect(connection.request.headers.authorization).toBe(`Bearer ${hostToken}`);
    expect(connection.request.url).toBe(`${PUBLIC_GATEWAY_HOST_CONNECT_PATH}?hostId=${hostId}`);
    const route = await connection.nextFrame();
    expect(route.kind).toBe("pairing_route");
    expect(JSON.stringify(route)).not.toContain("high-entropy-offer-secret");
    expect(JSON.stringify(route)).not.toContain("7F3K-M2QT");

    connection.send({
      schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
      kind: "request",
      requestId: "request_12345678",
      target: "relay",
      method: "POST",
      path: "/operator/v1/tail",
      headers: [
        { name: "authorization", value: "Bearer device-token" },
        { name: "content-type", value: "application/json" },
      ],
      bodyBase64: Buffer.from('{"schemaVersion":1,"op":"tail"}').toString("base64"),
    });
    const responseFrames = await connection.framesThrough("response_end");
    expect(responseFrames[0]).toMatchObject({ kind: "response_start", status: 200 });
    const body = responseFrames
      .filter((frame): frame is PublicGatewayResponseChunkFrame => frame.kind === "response_chunk")
      .map((frame) => Buffer.from(frame.bodyBase64, "base64").toString())
      .join("");
    expect(body).toBe('{"kind":"event"}\n{"kind":"done"}\n');
    expect(relayRequests).toEqual([
      { authorization: "Bearer device-token", body: '{"schemaVersion":1,"op":"tail"}' },
    ]);
    expect(logs.some((entry) => JSON.stringify(entry).includes("device-token"))).toBe(false);
    expect(connector.hostBaseUrl).toBe(`${gateway.origin}/h/${hostId}`);
  });

  it("replays live pairing routes after an authenticated reconnect", async () => {
    const target = await listen(createServer((_request, response) => response.end("{}")));
    const gateway = await fakeGateway();
    const connector = new PublicGatewayConnector({
      gatewayUrl: gateway.origin,
      hostId,
      hostToken,
      controlPlaneUrl: target,
      relayUrl: target,
      reconnectMinimumMs: 5,
      reconnectMaximumMs: 10,
    });
    connectors.push(connector);
    connector.start();
    await connector.publishPairingOffer({
      offerSecret: "replay-secret",
      code: "7F3K-M2QT",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const first = await gateway.nextConnection();
    const original = (await first.nextFrame()) as PublicGatewayPairingRouteFrame;
    first.socket.close(1012, "replace");
    const second = await gateway.nextConnection();
    expect(await second.nextFrame()).toEqual(original);
  });
});

interface FakeGatewayConnection {
  readonly socket: WebSocket;
  readonly request: import("node:http").IncomingMessage;
  nextFrame(): Promise<PublicGatewayTunnelFrame>;
  framesThrough(kind: PublicGatewayTunnelFrame["kind"]): Promise<PublicGatewayTunnelFrame[]>;
  send(frame: PublicGatewayTunnelFrame): void;
}

async function fakeGateway(): Promise<{
  readonly origin: string;
  nextConnection(): Promise<FakeGatewayConnection>;
}> {
  const pendingConnections: Array<(connection: FakeGatewayConnection) => void> = [];
  const connections: FakeGatewayConnection[] = [];
  const server = createServer();
  const webSockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      sockets.push(webSocket);
      const connection = fakeConnection(webSocket, request);
      const waiter = pendingConnections.shift();
      if (waiter === undefined) connections.push(connection);
      else waiter(connection);
    });
  });
  const origin = await listen(server);
  return {
    origin,
    nextConnection() {
      const existing = connections.shift();
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve) => pendingConnections.push(resolve));
    },
  };
}

function fakeConnection(
  socket: WebSocket,
  request: import("node:http").IncomingMessage,
): FakeGatewayConnection {
  const queued: PublicGatewayTunnelFrame[] = [];
  const waiters: Array<(frame: PublicGatewayTunnelFrame) => void> = [];
  socket.on("message", (data) => {
    const frame = PublicGatewayTunnelFrameSchema.parse(JSON.parse(data.toString()));
    if (frame.kind === "pairing_route") {
      socket.send(
        JSON.stringify({
          schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
          kind: "pairing_route_ready",
          offerHash: frame.offerHash,
        }),
      );
    }
    const waiter = waiters.shift();
    if (waiter === undefined) queued.push(frame);
    else waiter(frame);
  });
  const nextFrame = (): Promise<PublicGatewayTunnelFrame> => {
    const existing = queued.shift();
    return existing === undefined
      ? new Promise((resolve) => waiters.push(resolve))
      : Promise.resolve(existing);
  };
  return {
    socket,
    request,
    nextFrame,
    async framesThrough(kind) {
      const frames: PublicGatewayTunnelFrame[] = [];
      for (;;) {
        const frame = await nextFrame();
        frames.push(frame);
        if (frame.kind === kind) return frames;
      }
    },
    send(frame) {
      socket.send(JSON.stringify(frame));
    },
  };
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
