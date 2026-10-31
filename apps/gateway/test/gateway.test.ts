import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PUBLIC_GATEWAY_HOST_CONNECT_PATH,
  PUBLIC_GATEWAY_PAIRING_ROUTE_LIFETIME_MAX_MS,
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

  it("routes opaque encrypted exchanges and refuses plaintext pairing and bearer headers", async () => {
    const { origin } = await startGateway([]);
    const host = await connectHost(origin);
    openSockets.push(host);
    const response = fetch(`${origin}/h/${hostId}/v1/gateway/encrypted`, {
      method: "POST",
      body: "opaque envelope",
    });
    const frame = await nextRequest(host);
    expect(frame).toMatchObject({ target: "control", path: "/v1/gateway/encrypted" });
    expect(Buffer.from(frame.bodyBase64!, "base64").toString()).toBe("opaque envelope");
    respond(host, frame, 200, "opaque response");
    expect(await (await response).text()).toBe("opaque response");
    expect((await fetch(`${origin}/v1/pairing/redeem`, { method: "POST", body: "{}" })).status).toBe(426);
    expect(
      (await fetch(`${origin}/h/${hostId}/operator/v1/dispatch`, { method: "POST", body: "{}" })).status,
    ).toBe(426);
    // The retired hosted credits extension is no longer a route at all.
    expect((await fetch(`${origin}/h/${hostId}/v1/hosted/credits`)).status).toBe(404);
    expect((await fetch(`${origin}/h/${hostId}/v1/hosted/credits`, { method: "POST" })).status).toBe(404);
    expect(
      (
        await fetch(`${origin}/h/${hostId}/v1/gateway/encrypted`, {
          method: "POST",
          headers: { authorization: "Bearer plaintext" },
          body: "{}",
        })
      ).status,
    ).toBe(400);
  });

  it("keeps other requests alive when a cancelled response arrives late", async () => {
    const { origin } = await startGateway([]);
    const host = await connectHost(origin);
    openSockets.push(host);
    const abort = new AbortController();
    const cancelled = fetch(`${origin}/h/${hostId}/v1/gateway/challenge`, {
      signal: abort.signal,
    }).catch(() => undefined);
    const cancelledRequest = await nextRequest(host);
    const live = fetch(`${origin}/h/${hostId}/v1/gateway/challenge`);
    const liveRequest = await nextRequest(host);
    const cancellation = nextFrame(host);
    abort.abort();
    await cancelled;
    expect(await cancellation).toMatchObject({ kind: "cancel", requestId: cancelledRequest.requestId });

    // A response already in transit can cross the cancellation on the wire.
    const connectionState = Promise.race([
      once(host, "close").then(() => "closed"),
      once(host, "pong").then(() => "open"),
    ]);
    respond(host, cancelledRequest, 200, "late response");
    host.ping();
    expect(await connectionState).toBe("open");
    respond(host, liveRequest, 200, "still connected");
    expect(await (await live).text()).toBe("still connected");
  });

  it("carries a Linear delivery's signature and raw body to the Mac unaltered", async () => {
    const { origin } = await startGateway([]);
    const host = await connectHost(origin);
    openSockets.push(host);

    // Byte-for-byte matters here in a way it does not for any other route: the
    // HMAC covers these exact bytes, so re-encoding anywhere along the path
    // would make every real delivery look forged.
    const body = '{"action":"create","type":"Comment","data":{"body":"hi  there"}}';
    const hookPromise = fetch(`${origin}/h/${hostId}/v1/hooks/linear`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": "a".repeat(64),
        "linear-delivery": "delivery-1",
        "linear-event": "Comment",
        "linear-timestamp": "1757206800000",
      },
      body,
    });
    const hook = await nextRequest(host);

    expect(hook).toMatchObject({ target: "control", path: "/v1/hooks/linear" });
    expect(hook.headers).toContainEqual({ name: "linear-signature", value: "a".repeat(64) });
    expect(hook.headers).toContainEqual({ name: "linear-delivery", value: "delivery-1" });
    expect(hook.headers).toContainEqual({ name: "linear-event", value: "Comment" });
    expect(hook.headers).toContainEqual({ name: "linear-timestamp", value: "1757206800000" });
    expect(Buffer.from(hook.bodyBase64 ?? "", "base64").toString("utf8")).toBe(body);

    respond(host, hook, 200, '{"schemaVersion":1,"ingested":true}');
    expect((await hookPromise).status).toBe(200);
  });

  it("carries the Claude connector's OAuth and MCP calls in plaintext, and nothing more", async () => {
    const { origin } = await startGateway([]);
    const host = await connectHost(origin);
    openSockets.push(host);

    // Tool calls carry their own bearer, and a 401 hands Claude the discovery document.
    const mcpPromise = fetch(`${origin}/h/${hostId}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer connector-token",
        "mcp-protocol-version": "2025-06-18",
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    const mcp = await nextRequest(host);
    expect(mcp).toMatchObject({ target: "relay", method: "POST", path: "/mcp" });
    expect(mcp.headers).toContainEqual({ name: "authorization", value: "Bearer connector-token" });
    expect(mcp.headers).toContainEqual({ name: "mcp-protocol-version", value: "2025-06-18" });
    const challenge = `Bearer resource_metadata="${origin}/h/${hostId}/.well-known/oauth-protected-resource/mcp"`;
    send(host, {
      schemaVersion: 1,
      kind: "response_start",
      requestId: mcp.requestId,
      status: 401,
      headers: [
        { name: "content-type", value: "application/json" },
        { name: "www-authenticate", value: challenge },
        { name: "set-cookie", value: "never=forwarded" },
      ],
    });
    send(host, { schemaVersion: 1, kind: "response_end", requestId: mcp.requestId });
    const unauthorized = await mcpPromise;
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe(challenge);
    expect(unauthorized.headers.get("set-cookie")).toBeNull();

    // RFC 8414 and RFC 9728 discovery at the origin's root reach the same host.
    for (const [url, path] of [
      [
        `${origin}/.well-known/oauth-authorization-server/h/${hostId}`,
        "/.well-known/oauth-authorization-server",
      ],
      [
        `${origin}/.well-known/oauth-protected-resource/h/${hostId}/mcp`,
        "/.well-known/oauth-protected-resource/mcp",
      ],
      [
        `${origin}/h/${hostId}/.well-known/oauth-authorization-server`,
        "/.well-known/oauth-authorization-server",
      ],
    ] as const) {
      const discovery = fetch(url);
      const forwarded = await nextRequest(host);
      expect(forwarded).toMatchObject({ method: "GET", path });
      respond(host, forwarded, 200, "{}");
      expect((await discovery).status).toBe(200);
    }

    // The sign-in link is the one route that keeps its query.
    const query = "response_type=code&client_id=cc1.abc.def&code_challenge=x&state=s";
    const pagePromise = fetch(`${origin}/h/${hostId}/oauth/authorize?${query}`);
    const page = await nextRequest(host);
    expect(page).toMatchObject({ target: "control", method: "GET", path: `/oauth/authorize?${query}` });
    respond(host, page, 200, "{}");
    expect((await pagePromise).status).toBe(200);

    const tokenPromise = fetch(`${origin}/h/${hostId}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&client_id=c&refresh_token=r",
    });
    const tokenRequest = await nextRequest(host);
    expect(tokenRequest).toMatchObject({ target: "control", path: "/oauth/token" });
    expect(Buffer.from(tokenRequest.bodyBase64 ?? "", "base64").toString("utf8")).toBe(
      "grant_type=refresh_token&client_id=c&refresh_token=r",
    );
    respond(host, tokenRequest, 200, "{}");
    expect((await tokenPromise).status).toBe(200);

    // Everything else stays sealed: no other query, no bearer off /mcp, no other plaintext route.
    expect(
      (await fetch(`${origin}/h/${hostId}/oauth/authorize/status?x=1`, { method: "POST", body: "{}" }))
        .status,
    ).toBe(404);
    expect((await fetch(`${origin}/h/${hostId}/.well-known/oauth-authorization-server?x=1`)).status).toBe(
      404,
    );
    expect((await fetch(`${origin}/.well-known/oauth-authorization-server/h/${hostId}/extra`)).status).toBe(
      404,
    );
    expect(
      (
        await fetch(`${origin}/h/${hostId}/oauth/token`, {
          method: "POST",
          headers: {
            authorization: "Bearer device-token",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "grant_type=refresh_token",
        })
      ).status,
    ).toBe(400);
    expect((await fetch(`${origin}/h/${hostId}/v1/connector/sign-ins`)).status).toBe(426);
    expect((await fetch(`${origin}/h/${hostId}/mcp`, { method: "PUT" })).status).toBe(404);
    // A host that isn't connected answers 503 and never takes a connector budget slot.
    expect((await fetch(`${origin}/h/mac_nobody_12345678/mcp`, { method: "POST", body: "{}" })).status).toBe(
      503,
    );
  });

  it("rejects short gateway codes, unavailable hosts and private routes", async () => {
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
    expect((await typedPromise).status).toBe(426);

    expect((await fetch(`${origin}/h/${hostId}/v1/private`)).status).toBe(404);
    expect((await fetch(`${origin}/health?`)).status).toBe(404);
    host.close();
    await once(host, "close");
    expect(
      (
        await fetch(`${origin}/h/${hostId}/v1/gateway/encrypted`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(503);
  });

  it("routes a days-long review offer and closes on an expiry past the shared window", async () => {
    const { origin } = await startGateway([]);
    const host = await connectHost(origin);
    openSockets.push(host);
    const routeReady = nextFrame(host);
    send(host, {
      schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
      kind: "pairing_route",
      offerHash: hash("review-secret"),
      codeHash: hash("REV1EWCD"),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
    });
    expect(await routeReady).toMatchObject({ kind: "pairing_route_ready" });
    const redeemPromise = fetch(`${origin}/v1/pairing/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "rev1-ewcd", device: { name: "Reviewer", platform: "ios" } }),
    });
    expect((await redeemPromise).status).toBe(426);

    const closed = once(host, "close");
    send(host, {
      schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
      kind: "pairing_route",
      offerHash: hash("too-long"),
      codeHash: hash("TOOLONG1"),
      expiresAt: new Date(Date.now() + PUBLIC_GATEWAY_PAIRING_ROUTE_LIFETIME_MAX_MS + 60_000).toISOString(),
    });
    const [code] = (await closed) as [number];
    expect(code).toBe(1008);
  });

  it("admits only bounded join metadata and opaque machine envelopes, never plaintext owner approval", async () => {
    const logs: Array<{ fields: Readonly<Record<string, unknown>>; message: string }> = [];
    const { origin } = await startGateway(logs);
    const host = await connectHost(origin);
    openSockets.push(host);
    const secret = "x".repeat(43);
    const id = "11111111-1111-4111-8111-111111111111";
    const envelope = {
      machineId: `join-${id}`,
      challenge: secret,
      requestId: id,
      sealedRequest: "opaque-ciphertext",
    };
    const cases = [
      [
        "/v1/machine-joins/start",
        {
          name: "fixture",
          platform: "darwin",
          directories: ["/fixture"],
          claimSecret: secret,
          approvalHash: "a".repeat(64),
        },
        undefined,
      ],
      ["/v1/machine-joins/status", { joinId: id }, secret],
      ["/v1/joined-machines/challenge", { machineId: `join-${id}` }, undefined],
      ["/v1/joined-machines/channel", envelope, undefined],
      ["/v1/joined-machines/leave", envelope, undefined],
    ] as const;
    for (const [path, value, bearer] of cases) {
      const body = JSON.stringify(value);
      const received = nextRequest(host);
      const response = fetch(`${origin}/h/${hostId}${path}`, {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
      });
      const frame = await received;
      expect(frame.target).toBe("control");
      expect(frame.path).toBe(path);
      expect(Buffer.from(frame.bodyBase64!, "base64").toString()).toBe(body);
      expect(frame.headers.filter((header) => header.name === "authorization")).toEqual(
        bearer ? [{ name: "authorization", value: `Bearer ${bearer}` }] : [],
      );
      respond(host, frame, 200, '{"sealedResponse":"opaque-response"}');
      expect(await (await response).json()).toEqual({ sealedResponse: "opaque-response" });
    }
    const rejected = [
      [
        "POST",
        "/v1/machine-joins/approve",
        { code: secret, accessLevel: "screen", directories: [] },
        "owner-bearer",
        426,
      ],
      ["POST", "/v1/joined-machines/channel", envelope, secret, 400],
      ["POST", "/v1/machine-joins/status", { joinId: id }, "clankie_join_" + secret, 400],
      ["POST", "/v1/machine-joins/status", { joinId: id }, undefined, 400],
      ["POST", "/v1/joined-machines/challenge", { machineId: "local" }, undefined, 400],
      ["POST", "/v1/joined-machines/channel", { ...envelope, accessLevel: "screen" }, undefined, 400],
      ["POST", "/v1/joined-machines/channel?token=secret", envelope, undefined, 404],
      ["GET", "/v1/joined-machines/channel", undefined, undefined, 404],
      ["POST", "/v1/joined-machines/remove", envelope, undefined, 404],
      [
        "POST",
        "/v1/joined-machines/leave",
        { ...envelope, sealedRequest: "x".repeat(17 * 1024) },
        undefined,
        413,
      ],
      [
        "POST",
        "/v1/joined-machines/channel",
        { ...envelope, sealedRequest: "x".repeat(2 * 1024 * 1024) },
        undefined,
        413,
      ],
    ] as const;
    for (const [method, path, body, bearer, status] of rejected) {
      const response = await fetch(`${origin}/h/${hostId}${path}`, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
        headers: {
          "content-type": "application/json",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
      });
      expect(response.status, path).toBe(status);
      await response.text();
    }
    expect(JSON.stringify(logs)).not.toContain(secret);
    expect(JSON.stringify(logs)).not.toContain("opaque-ciphertext");
    expect(JSON.stringify(logs)).not.toContain("/fixture");
  });

  it.each([false, true])(
    "bounds start attempts before parsing and refills (trusted proxy: %s)",
    async (trustedProxy) => {
      let now = Date.now();
      const { origin } = await startGateway([], {
        clock: () => now,
        ...(trustedProxy ? { trustedProxy: { trusts: () => true, refresh: async () => {} } } : {}),
      });
      const host = await connectHost(origin);
      openSockets.push(host);
      const url = `${origin}/h/${hostId}/v1/machine-joins/start`;
      let peer = 1;
      const attempt = async () => {
        const response = await fetch(url, {
          method: "POST",
          body: "malformed",
          headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${peer++}` },
        });
        await response.text();
        return response;
      };
      // Direct peers cannot rotate claimed addresses; trusted proxy clients still
      // share the destination-host budget and cannot amplify bootstrap admission.
      for (let index = 0; index < 32; index++) expect((await attempt()).status).toBe(400);
      const throttled = await attempt();
      expect(throttled.status).toBe(429);
      expect(throttled.headers.get("retry-after")).toBe("5");
      now += 5000;
      expect((await attempt()).status).toBe(400);
      // Bootstrap exhaustion does not spend the encrypted-machine transport bucket.
      const challenge = await fetch(`${origin}/h/${hostId}/v1/joined-machines/challenge`, {
        method: "POST",
        body: "{}",
      });
      expect(challenge.status).toBe(400);
    },
  );

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
  extra: Partial<Parameters<typeof createPublicGateway>[0]> = {},
): Promise<{ readonly gateway: PublicGateway; readonly origin: string }> {
  const gateway = createPublicGateway({
    hostTokens: new Map([[hostId, hostToken]]),
    ...extra,
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
