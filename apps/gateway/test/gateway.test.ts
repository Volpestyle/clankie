import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PUBLIC_GATEWAY_HOST_CONNECT_PATH,
  PUBLIC_GATEWAY_SCHEMA_VERSION,
  PublicGatewayTunnelFrameSchema,
  derivePublicGatewayHostId,
  type PublicGatewayRequestFrame,
  type PublicGatewayTunnelFrame,
} from "@clankie/protocol/public-gateway";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  createPublicGateway,
  loadHostTokens,
  parseHostTokensJson,
  type PublicGateway,
} from "../src/gateway.ts";

const hostId = "mac_james_12345678";
const hostToken = "gateway-host-token-that-is-longer-than-thirty-two-characters";
const openGateways: PublicGateway[] = [];
const openSockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.close();
  await Promise.all(openGateways.splice(0).map((gateway) => gateway.close()));
});

describe("public gateway", () => {
  it("discovers account config and binds a signed account to one installation", async () => {
    const installationId = "i".repeat(22);
    const accountId = "account-1";
    const accountHostId = derivePublicGatewayHostId(accountId, installationId);
    const accountConfig = {
      schemaVersion: 1,
      account: {
        provider: "cognito_email_otp",
        endpoint: "https://cognito-idp.us-east-1.amazonaws.com",
        issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool",
        clientId: "client123",
        selfSignUpEnabled: false,
      },
    } as const;
    const gateway = createPublicGateway({
      hostTokens: new Map(),
      accountConfig,
      authenticateAccountToken: async (token) => {
        if (token !== "signed-access") throw new Error("denied");
        return { accountId, expiresAtMs: Date.now() + 30_000 };
      },
    });
    openGateways.push(gateway);
    gateway.server.listen(0, "127.0.0.1");
    await once(gateway.server, "listening");
    const address = gateway.server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;

    expect(await (await fetch(`${origin}/gateway/v1/config`)).json()).toEqual(accountConfig);
    const socket = new WebSocket(
      `${origin.replace("http", "ws")}${PUBLIC_GATEWAY_HOST_CONNECT_PATH}?hostId=${accountHostId}&installationId=${installationId}`,
      { headers: { authorization: "Bearer signed-access" } },
    );
    openSockets.push(socket);
    await once(socket, "open");

    const denied = new WebSocket(
      `${origin.replace("http", "ws")}${PUBLIC_GATEWAY_HOST_CONNECT_PATH}?hostId=${hostId}&installationId=${installationId}`,
      { headers: { authorization: "Bearer signed-access" } },
    );
    openSockets.push(denied);
    const [error] = (await once(denied, "error")) as [Error];
    expect(error.message).toMatch(/401/u);
  });

  it("routes one-time pairing and host-scoped relay exchanges over the Mac connection", async () => {
    const logs: Array<{ readonly fields: Readonly<Record<string, unknown>>; readonly message: string }> = [];
    const { gateway, origin } = await startGateway(logs);
    const host = await connectHost(origin);
    openSockets.push(host);
    const routeReady = nextFrame(host);
    send(host, {
      schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
      kind: "pairing_route",
      offerHash: hash("offer-secret"),
      codeHash: hash("7F3KM2QT"),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(await routeReady).toMatchObject({ kind: "pairing_route_ready" });

    const redeemPromise = fetch(`${origin}/v1/pairing/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offerSecret: "offer-secret", device: { name: "iPhone", platform: "ios" } }),
    });
    const redeemRequest = await nextRequest(host);
    expect(redeemRequest).toMatchObject({ target: "control", path: "/v1/pairing/redeem" });
    expect(JSON.parse(Buffer.from(redeemRequest.bodyBase64 ?? "", "base64").toString("utf8"))).toMatchObject({
      offerSecret: "offer-secret",
    });
    respond(host, redeemRequest, 200, JSON.stringify({ deviceId: "device-1" }));
    const redeem = await redeemPromise;
    expect(redeem.status).toBe(200);
    expect(await redeem.json()).toEqual({ deviceId: "device-1" });

    const duplicate = await fetch(`${origin}/v1/pairing/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offerSecret: "offer-secret", device: { name: "iPhone", platform: "ios" } }),
    });
    expect(duplicate.status).toBe(410);

    const dispatchPromise = fetch(`${origin}/h/${hostId}/operator/v1/dispatch`, {
      method: "POST",
      headers: { authorization: "Bearer device-token", "content-type": "application/json" },
      body: JSON.stringify({ op: "list", schemaVersion: 1 }),
    });
    const dispatch = await nextRequest(host);
    expect(dispatch).toMatchObject({ target: "relay", path: "/operator/v1/dispatch" });
    expect(dispatch.headers).toContainEqual({ name: "authorization", value: "Bearer device-token" });
    respond(host, dispatch, 200, '{"schemaVersion":1,"result":{}}');
    expect(await (await dispatchPromise).json()).toEqual({ schemaVersion: 1, result: {} });

    expect(logs.some((entry) => JSON.stringify(entry).includes("offer-secret"))).toBe(false);
    expect(logs.some((entry) => JSON.stringify(entry).includes("device-token"))).toBe(false);
    expect(gateway.server.listening).toBe(true);
  });

  it("routes normalized typed codes and rejects unavailable hosts and private routes", async () => {
    const logs: Array<{ readonly fields: Readonly<Record<string, unknown>>; readonly message: string }> = [];
    const { origin } = await startGateway(logs);
    const host = await connectHost(origin);
    openSockets.push(host);
    const routeReady = nextFrame(host);
    send(host, {
      schemaVersion: 1,
      kind: "pairing_route",
      offerHash: hash("unused-secret"),
      codeHash: hash("7F3KM2QT"),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(await routeReady).toMatchObject({ kind: "pairing_route_ready" });

    const typedPromise = fetch(`${origin}/v1/pairing/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "7f3k-m2qt", device: { name: "iPad", platform: "ios" } }),
    });
    const typed = await nextRequest(host);
    respond(host, typed, 200, "{}");
    expect((await typedPromise).status).toBe(200);

    expect((await fetch(`${origin}/h/${hostId}/v1/private`)).status).toBe(404);
    expect((await fetch(`${origin}/health?`)).status).toBe(404);
    host.close();
    await once(host, "close");
    expect(
      (
        await fetch(`${origin}/h/${hostId}/operator/v1/dispatch`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(503);
  });

  it("fails host authentication closed and validates configured credentials", async () => {
    expect(() => parseHostTokensJson("{}")).toThrow(/At least one/u);
    expect(() => parseHostTokensJson(JSON.stringify({ short: "tiny" }))).toThrow(/valid host id/u);
    const { origin } = await startGateway([]);
    const denied = new WebSocket(
      `${origin.replace("http", "ws")}${PUBLIC_GATEWAY_HOST_CONNECT_PATH}?hostId=${hostId}`,
      { headers: { authorization: "Bearer wrong-token" } },
    );
    openSockets.push(denied);
    const [error] = (await once(denied, "error")) as [Error];
    expect(error.message).toMatch(/401/u);
  });

  it("loads production host credentials from a mounted file, never two sources", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clankie-gateway-test-"));
    const file = join(directory, "host-tokens.json");
    try {
      await writeFile(file, JSON.stringify({ [hostId]: hostToken }), { mode: 0o600 });
      expect(loadHostTokens({ CLANKIE_GATEWAY_HOST_TOKENS_FILE: file }).get(hostId)).toBe(hostToken);
      expect(() =>
        loadHostTokens({
          CLANKIE_GATEWAY_HOST_TOKENS_FILE: file,
          CLANKIE_GATEWAY_HOST_TOKENS_JSON: JSON.stringify({ [hostId]: hostToken }),
        }),
      ).toThrow(/not both/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function startGateway(
  logs: Array<{ readonly fields: Readonly<Record<string, unknown>>; readonly message: string }>,
): Promise<{ readonly gateway: PublicGateway; readonly origin: string }> {
  const gateway = createPublicGateway({
    hostTokens: new Map([[hostId, hostToken]]),
    logger: {
      info: (fields, message) => logs.push({ fields, message }),
      warn: (fields, message) => logs.push({ fields, message }),
    },
  });
  openGateways.push(gateway);
  gateway.server.listen(0, "127.0.0.1");
  await once(gateway.server, "listening");
  const address = gateway.server.address() as AddressInfo;
  return { gateway, origin: `http://127.0.0.1:${address.port}` };
}

async function connectHost(origin: string): Promise<WebSocket> {
  const socket = new WebSocket(
    `${origin.replace("http", "ws")}${PUBLIC_GATEWAY_HOST_CONNECT_PATH}?hostId=${hostId}`,
    { headers: { authorization: `Bearer ${hostToken}` } },
  );
  await once(socket, "open");
  return socket;
}

async function nextRequest(socket: WebSocket): Promise<PublicGatewayRequestFrame> {
  const frame = await nextFrame(socket);
  if (frame.kind !== "request") throw new Error(`Expected request, received ${frame.kind}`);
  return frame;
}

async function nextFrame(socket: WebSocket): Promise<PublicGatewayTunnelFrame> {
  const [data] = (await once(socket, "message")) as [Buffer];
  return PublicGatewayTunnelFrameSchema.parse(JSON.parse(data.toString()));
}

function respond(socket: WebSocket, request: PublicGatewayRequestFrame, status: number, body: string): void {
  send(socket, {
    schemaVersion: 1,
    kind: "response_start",
    requestId: request.requestId,
    status,
    headers: [{ name: "content-type", value: "application/json" }],
  });
  send(socket, {
    schemaVersion: 1,
    kind: "response_chunk",
    requestId: request.requestId,
    sequence: 0,
    bodyBase64: Buffer.from(body).toString("base64"),
  });
  send(socket, { schemaVersion: 1, kind: "response_end", requestId: request.requestId });
}

function send(socket: WebSocket, frame: PublicGatewayTunnelFrame): void {
  socket.send(JSON.stringify(frame));
}

function hash(value: string): `${string}` {
  return createHash("sha256").update(value).digest("hex");
}
