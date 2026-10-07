import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  PUBLIC_GATEWAY_HOST_CONNECT_PATH,
  PUBLIC_GATEWAY_SCHEMA_VERSION,
  PublicGatewayTunnelFrameSchema,
  publicGatewayTargetFor,
  type PublicGatewayPairingRouteFrame,
  type PublicGatewayResponseChunkFrame,
  type PublicGatewayTunnelFrame,
} from "@clankie/protocol/public-gateway";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  createClankieAccountTokenProvider,
  clankieAccountSignInRequired,
  type ProviderCredential,
} from "@clankie/credential-broker";
import { PublicGatewayConnector } from "../src/public-gateway-connector.ts";
import { gatewayRequestAad } from "@clankie/protocol/gateway-encryption";
import { ProjectsSettingsSchema, TAKE_CONTROL_GRANTS } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { ClankieApiClient } from "../../../packages/api-client/src/index.ts";
import { createGatewayEncryptedFetch } from "../../../packages/api-client/src/gateway-encryption.ts";
import { createOperatorConversationRelayHandler } from "../../relay/src/operator-conversations.ts";
import { ControlPlaneDeviceAuthorizer } from "../../relay/src/device-auth.ts";
import { createClankieApp, type ClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";
import { sealGatewayValue, openGatewayValue } from "../src/gateway-encryption.ts";

const hostId = "mac_james_12345678";
const hostToken = "gateway-host-token-that-is-longer-than-thirty-two-characters";
const servers: Server[] = [];
const connectors: PublicGatewayConnector[] = [];
const sockets: WebSocket[] = [];
const apps: ClankieApp[] = [];
const roots: string[] = [];

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
  apps.splice(0).forEach((app) => app.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("public gateway Mac connector", () => {
  it("carries encrypted original-device fleet/project settings through the real socket, relay, service and persistence without losing the opt-in query", async () => {
    const root = await mkdtemp(join(tmpdir(), "encrypted-fleet-settings-"));
    roots.push(root);
    const settings = new SettingsStore(join(root, "settings.json"));
    await settings.update((current) => ({
      ...current,
      projects: ProjectsSettingsSchema.parse({
        projects: [{ id: "garden", name: "Garden", autonomy: { fleet: { closure: "owner" } } }],
      }),
    }));
    const now = Date.now(),
      deviceKey = randomBytes(32),
      signer = new DeviceSessionSigner(deviceKey);
    const deviceToken = signer.issue(
      mintDeviceSessionClaims({
        deviceId: "control",
        nowEpochSeconds: Math.floor(now / 1000),
        ttlSeconds: 600,
      }),
    );
    const base = {
      occurredAt: new Date(now).toISOString(),
      missionId: "device:control",
      correlationId: "fixture",
      profileHash: "fixture",
    };
    const eventLogPath = join(root, "events.jsonl");
    await writeFile(
      eventLogPath,
      [
        {
          ...base,
          id: randomUUID(),
          type: "device.pairing.redeemed",
          data: {
            schemaVersion: 1,
            deviceId: "control",
            offerId: "fixture",
            name: "Phone",
            platform: "ios",
            offeredGrants: TAKE_CONTROL_GRANTS,
            mintedBy: "local-owner",
            pendingExpiresAt: new Date(now + 600_000).toISOString(),
          },
        },
        {
          ...base,
          id: randomUUID(),
          type: "device.activated",
          data: {
            schemaVersion: 1,
            deviceId: "control",
            grants: TAKE_CONTROL_GRANTS,
            sessionExpiresAt: new Date(now + 600_000).toISOString(),
          },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    );
    const app = await createClankieApp({
      captain: createStubCaptain(),
      settings,
      eventLogPath,
      deviceSessionKey: deviceKey,
      authenticateOperator: async () => undefined,
    });
    apps.push(app);
    const control = await listen(
      createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === "string") headers.set(name, value);
          else if (value) value.forEach((entry) => headers.append(name, entry));
        }
        const body = Buffer.concat(chunks);
        const result = await app.app.fetch(
          new Request(`http://${request.headers.host}${request.url}`, {
            method: request.method ?? "GET",
            headers,
            ...(body.length ? { body } : {}),
          }),
        );
        response.statusCode = result.status;
        result.headers.forEach((value, name) => response.setHeader(name, value));
        response.end(Buffer.from(await result.arrayBuffer()));
      }),
    );
    const forwarded: Array<{ path: string; token: string }> = [];
    const handler = createOperatorConversationRelayHandler({
      authorizeDevice: new ControlPlaneDeviceAuthorizer({ baseUrl: control }),
      dispatch: async () => {
        throw new Error("Settings must not use captain dispatch");
      },
      roomRequest: async (path, method, token, body) => {
        forwarded.push({ path, token });
        return fetch(new URL(path, control), {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body }),
          redirect: "error",
        });
      },
    });
    const relay = await listen(
      createServer((request, response) => {
        void handler(request, response).then((handled) => {
          if (!handled) {
            response.statusCode = 404;
            response.end();
          }
        });
      }),
    );
    const gateway = await fakeGateway(),
      wrappingKey = randomBytes(32),
      key = randomBytes(32).toString("base64");
    const credential = {
      hostId,
      key,
      ticket: sealGatewayValue(
        wrappingKey,
        JSON.stringify({ key, subject: "control", stage: "device", expiresAt: now + 600_000 }),
        `clankie-gateway-ticket-v1:${hostId}`,
      ),
    };
    const connector = new PublicGatewayConnector({
      gatewayUrl: gateway.origin,
      hostId,
      hostToken,
      encryptionKey: wrappingKey,
      controlPlaneUrl: control,
      relayUrl: relay,
      logger: { info: () => {}, warn: () => {} },
    });
    connectors.push(connector);
    connector.start();
    const connection = await gateway.nextConnection();
    const outer: string[] = [];
    const raw: typeof fetch = async (input, init) => {
      const request = new Request(input, init),
        url = new URL(request.url),
        path = url.pathname.slice(`/h/${hostId}`.length);
      const body = await request.text();
      outer.push(JSON.stringify({ path, headers: [...request.headers], body }));
      const method = request.method === "GET" ? "GET" : "POST",
        target = publicGatewayTargetFor(method, path);
      if (target === undefined) throw new Error("Unroutable fixture envelope");
      connection.send({
        schemaVersion: 1,
        kind: "request",
        requestId: randomBytes(16).toString("hex"),
        target,
        method,
        path,
        headers: Array.from(request.headers, ([name, value]) => ({ name, value })),
        ...(body ? { bodyBase64: Buffer.from(body).toString("base64") } : {}),
      });
      const frames = await connection.framesThrough("response_end"),
        start = frames.find((frame) => frame.kind === "response_start");
      if (!start || start.kind !== "response_start") throw new Error("Missing connector response");
      const bytes = Buffer.concat(
        frames
          .filter((frame): frame is PublicGatewayResponseChunkFrame => frame.kind === "response_chunk")
          .map((frame) => Buffer.from(frame.bodyBase64, "base64")),
      );
      return new Response(bytes, {
        status: start.status,
        headers: start.headers.map(({ name, value }): [string, string] => [name, value]),
      });
    };
    const encrypted = createGatewayEncryptedFetch({
      credential: () => credential,
      crypto: {
        randomBytes,
        seal: async (cipherKey, value, aad) => sealGatewayValue(Buffer.from(cipherKey, "base64"), value, aad),
        open: async (cipherKey, value, aad) => openGatewayValue(Buffer.from(cipherKey, "base64"), value, aad),
      },
      fetchImpl: raw,
    });
    const client = new ClankieApiClient({
      baseUrl: "http://device.clankie.invalid",
      operatorToken: deviceToken,
      fetchImpl: (input, init) => {
        const url = new URL(String(input));
        return encrypted(`${gateway.origin}/h/${hostId}${url.pathname}${url.search}`, init);
      },
    });
    const fleet = await client.fleetSettings();
    await client.updateFleetSettings({
      schemaVersion: 1,
      expectedRevision: fleet.revision,
      changes: { machineSetup: "owner" },
    });
    const projects = await client.projects();
    expect(projects.autonomyDefaults?.fleet.machineSetup).toBe("owner");
    expect(projects.settings.projects[0]!.autonomy?.fleet?.closure).toBe("owner");
    await client.updateProjectSettings({
      projectId: "garden",
      expectedRevision: projects.revision,
      changes: { autonomy: { fleet: { closure: null, machineSetup: "lead" } } },
    });
    expect(forwarded.map((entry) => entry.path)).toEqual([
      "/v1/operator/fleet-settings",
      "/v1/operator/fleet-settings",
      "/v1/operator/projects?includeAutonomy=true",
      "/v1/operator/projects/update?includeAutonomy=true",
    ]);
    expect(forwarded.every((entry) => entry.token === deviceToken)).toBe(true);
    const saved = await new SettingsStore(settings.path).load();
    expect(saved.autonomy.fleet.machineSetup).toBe("owner");
    expect(saved.projects.projects[0]!.autonomy).toEqual({ fleet: { machineSetup: "lead" } });
    expect(JSON.stringify(outer)).not.toContain(deviceToken);
    expect(JSON.stringify(outer)).not.toContain("includeAutonomy");
    for (const path of [
      "/v1/operator/projects?includeAutonomy=true&unknown=true",
      "/v1/operator/projects?includeAutonomy=true&includeAutonomy=true",
      "/v1/operator/projects?include%41utonomy=true",
    ])
      await expect(
        encrypted(`${gateway.origin}/h/${hostId}${path}`, {
          headers: { authorization: `Bearer ${deviceToken}` },
        }),
      ).rejects.toThrow("identity mismatch");
    // Bypass the client's URL admission with valid cryptography: the host still
    // refuses query tricks and filesystem authority before reaching the relay.
    for (const path of [
      "/v1/operator/fleet-settings/context",
      "/v1/operator/projects/create",
      "/v1/operator/projects?includeAutonomy=true&unknown=true",
      "/v1/operator/projects?includeAutonomy=true&includeAutonomy=true",
      "/v1/operator/projects?include%41utonomy=true",
      "/v1/operator/%70rojects?includeAutonomy=true",
    ]) {
      const challenge = (await (await raw(`${gateway.origin}/h/${hostId}/v1/gateway/challenge`)).json()) as {
        challenge: string;
      };
      const context = {
        ticket: credential.ticket,
        challenge: challenge.challenge,
        requestId: randomBytes(32).toString("hex"),
      };
      const sealed = sealGatewayValue(
        Buffer.from(key, "base64"),
        JSON.stringify({
          method: "GET",
          path,
          headers: [{ name: "authorization", value: `Bearer ${deviceToken}` }],
          responseKey: randomBytes(32).toString("base64"),
        }),
        gatewayRequestAad(hostId, context),
      );
      const result = await raw(`${gateway.origin}/h/${hostId}/v1/gateway/encrypted`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, ...context, sealed }),
      });
      expect(result.status).toBe(401);
      expect(await result.json()).toEqual({ error: "invalid_encrypted_request" });
    }
    expect(forwarded).toHaveLength(4);
  });
  it("registers hashed offers and refuses plaintext application forwarding", async () => {
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
    expect(responseFrames[0]).toMatchObject({ kind: "response_start", status: 426 });
    const body = responseFrames
      .filter((frame): frame is PublicGatewayResponseChunkFrame => frame.kind === "response_chunk")
      .map((frame) => Buffer.from(frame.bodyBase64, "base64").toString())
      .join("");
    expect(JSON.parse(body)).toEqual({ error: "encryption_required" });
    expect(relayRequests).toEqual([]);
    expect(logs.some((entry) => JSON.stringify(entry).includes("device-token"))).toBe(false);
    expect(connector.hostBaseUrl).toBe(`${gateway.origin}/h/${hostId}`);
  });

  it("hands the control plane a Linear signature and the bytes it covers", async () => {
    const received: Array<{ readonly headers: Record<string, string | undefined>; readonly body: string }> =
      [];
    const control = await listen(
      createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk.toString();
        received.push({
          headers: {
            signature: request.headers["linear-signature"] as string | undefined,
            delivery: request.headers["linear-delivery"] as string | undefined,
            event: request.headers["linear-event"] as string | undefined,
            timestamp: request.headers["linear-timestamp"] as string | undefined,
            gateway: request.headers["x-clankie-gateway"] as string | undefined,
          },
          body,
        });
        response.end('{"schemaVersion":1,"ingested":true}');
      }),
    );
    const relay = await listen(createServer((_request, response) => response.end("{}")));
    const gateway = await fakeGateway();
    const connector = new PublicGatewayConnector({
      gatewayUrl: gateway.origin,
      hostId,
      hostToken,
      controlPlaneUrl: control,
      relayUrl: relay,
      logger: { info: () => {}, warn: () => {} },
      reconnectMinimumMs: 5,
      reconnectMaximumMs: 10,
    });
    connectors.push(connector);
    connector.start();
    const connection = await gateway.nextConnection();

    const body = '{"action":"create","type":"Comment","data":{"body":"hi  there"}}';
    connection.send({
      schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
      kind: "request",
      requestId: "request_87654321",
      target: "control",
      method: "POST",
      path: "/v1/hooks/linear",
      headers: [
        { name: "content-type", value: "application/json" },
        { name: "linear-signature", value: "b".repeat(64) },
        { name: "linear-delivery", value: "delivery-1" },
        { name: "linear-event", value: "Comment" },
        { name: "linear-timestamp", value: "1757206800000" },
      ],
      bodyBase64: Buffer.from(body).toString("base64"),
    });
    await connection.framesThrough("response_end");

    // The signature is worthless if either the headers or the exact bytes are
    // reshaped on the way through this hop.
    expect(received).toEqual([
      {
        headers: {
          signature: "b".repeat(64),
          delivery: "delivery-1",
          event: "Comment",
          timestamp: "1757206800000",
          gateway: "1",
        },
        body,
      },
    ]);
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

  it("sends a restored review route on the first connect without a socket at restore time", async () => {
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
    const route = {
      offerHash: "a".repeat(64),
      codeHash: "b".repeat(64),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
    };
    connector.restorePairingRoute(route);
    connector.start();
    const connection = await gateway.nextConnection();
    expect(await connection.nextFrame()).toEqual({
      schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
      kind: "pairing_route",
      ...route,
    });
  });

  it("uses renewable account credentials with the installation-bound route", async () => {
    const target = await listen(createServer((_request, response) => response.end("{}")));
    const gateway = await fakeGateway();
    const installationId = "YWFhYWFhYWFhYWFhYWFhYQ";
    let resolutions = 0;
    const connector = new PublicGatewayConnector({
      gatewayUrl: gateway.origin,
      hostId,
      installationId,
      resolveHostToken: async () => {
        resolutions += 1;
        return { token: "account-access-token", expiresAt: Date.now() + 60 * 60_000 };
      },
      controlPlaneUrl: target,
      relayUrl: target,
      reconnectMinimumMs: 5,
      reconnectMaximumMs: 10,
    });
    connectors.push(connector);
    connector.start();

    const connection = await gateway.nextConnection();
    expect(resolutions).toBe(1);
    expect(connection.request.headers.authorization).toBe("Bearer account-access-token");
    expect(connection.request.url).toBe(
      `${PUBLIC_GATEWAY_HOST_CONNECT_PATH}?hostId=${hostId}&installationId=${installationId}`,
    );
  });

  it("backs off through an offline wake, then recovers a lost rotation and reconnects signed in", async () => {
    const gateway = await fakeGateway();
    const access = [
      "header",
      Buffer.from(JSON.stringify({ sub: "account-1", client_id: "client123", token_use: "access" })).toString(
        "base64url",
      ),
      "signature",
    ].join(".");
    let stored: ProviderCredential = {
      type: "oauth",
      access,
      refresh: "refresh-1",
      expires: Date.now() + 3_600_000,
      accountId: "account-1",
      clientId: "client123",
    };
    let online = false;
    let probes = 0;
    const spent: Array<{ token: string; at: number }> = [];
    const transitions: string[] = [];
    const resolveHostToken = createClankieAccountTokenProvider({
      gatewayUrl: gateway.origin,
      store: {
        get: async () => stored,
        set: async (_id, credential) => {
          stored = credential;
        },
        delete: async () => false,
        list: async () => ({}),
      },
      fetchImpl: async (input, init) => {
        if (String(input).endsWith("/gateway/v1/config"))
          return Response.json({
            schemaVersion: 1,
            account: {
              provider: "cognito_email_otp",
              endpoint: "https://cognito-idp.us-east-1.amazonaws.com",
              issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool",
              clientId: "client123",
              selfSignUpEnabled: false,
            },
          });
        if (init?.method === "HEAD") {
          probes += 1;
          if (!online) throw new TypeError("network not ready after wake");
          return new Response(null, { status: 400 });
        }
        spent.push({
          token: (JSON.parse(String(init?.body)) as { RefreshToken: string }).RefreshToken,
          at: Date.now(),
        });
        if (spent.length === 1) throw new TypeError("server rotated; reply lost");
        if (Date.now() - spent[0]!.at >= 60_000)
          return Response.json({ __type: "RefreshTokenReuseException" }, { status: 400 });
        return Response.json({ AuthenticationResult: { AccessToken: access, RefreshToken: "refresh-3" } });
      },
    });
    const connector = new PublicGatewayConnector({
      gatewayUrl: gateway.origin,
      hostId,
      installationId: "YWFhYWFhYWFhYWFhYWFhYQ",
      resolveHostToken,
      tokenErrorIsTerminal: clankieAccountSignInRequired,
      controlPlaneUrl: gateway.origin,
      relayUrl: gateway.origin,
      reconnectMinimumMs: 5,
      reconnectMaximumMs: 20,
      onDoorwayChange: (change) => transitions.push(change.state),
    });
    connectors.push(connector);
    connector.start();
    const initial = await gateway.nextConnection();
    await vi.waitFor(() => expect(connector.doorway.state).toBe("connected"));
    // Sleep expires the token and loses the socket. Gateway discovery can come
    // back before the separate Cognito route is usable.
    stored = { ...stored, expires: 1 };
    initial.socket.close();
    await vi.waitFor(() => expect(probes).toBeGreaterThanOrEqual(2));
    expect(spent).toEqual([]);
    expect(connector.doorway.state).toBe("connecting");
    online = true;
    const recovered = await gateway.nextConnection();
    await vi.waitFor(() => expect(connector.doorway.state).toBe("connected"));
    expect(recovered.request.headers.authorization).toBe(`Bearer ${access}`);
    expect(spent.map(({ token }) => token)).toEqual(["refresh-1", "refresh-1"]);
    expect(spent[1]!.at - spent[0]!.at).toBeLessThan(60_000);
    expect(stored).toMatchObject({ refresh: "refresh-3" });
    expect(transitions).not.toContain("sign_in_required");
  });

  it("parks on a credential no retry can fix and says the Mac needs signing in", async () => {
    const target = await listen(createServer((_request, response) => response.end("{}")));
    const gateway = await fakeGateway();
    const logs: Array<{ readonly fields: Readonly<Record<string, unknown>>; readonly message: string }> = [];
    let resolutions = 0;
    const transitions: string[] = [];
    const connector = new PublicGatewayConnector({
      gatewayUrl: gateway.origin,
      hostId,
      installationId: "YWFhYWFhYWFhYWFhYWFhYQ",
      resolveHostToken: () => {
        resolutions += 1;
        return Promise.reject(
          Object.assign(new Error("Clankie account refused this Mac's refresh token"), {
            name: "ClankieAccountAuthError",
            code: "refresh_rejected",
          }),
        );
      },
      tokenErrorIsTerminal: () => true,
      onDoorwayChange: (change) => transitions.push(change.state),
      controlPlaneUrl: target,
      relayUrl: target,
      logger: { info: () => undefined, warn: (fields, message) => logs.push({ fields, message }) },
      reconnectMinimumMs: 1,
      reconnectMaximumMs: 2,
    });
    connectors.push(connector);
    connector.start();

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(resolutions).toBe(1);
    expect(transitions).toEqual(["sign_in_required"]);
    expect(logs.map(({ message }) => message)).toEqual(["public gateway needs this Mac signed in again"]);
    // The code rides along, so the log names which failure parked the doorway.
    expect(logs[0]?.fields).toMatchObject({ error: "ClankieAccountAuthError", code: "refresh_rejected" });
    expect(connector.doorway).toMatchObject({ state: "sign_in_required" });
  });

  it("parks a managed connector when the gateway rejects its host upgrade", async () => {
    let attempts = 0,
      rejections = 0;
    const gateway = await listen(
      createServer((_request, response) => {
        attempts++;
        response.writeHead(403).end();
      }),
    );
    const connector = new PublicGatewayConnector({
      gatewayUrl: gateway,
      hostId,
      hostToken,
      controlPlaneUrl: gateway,
      relayUrl: gateway,
      reconnectMinimumMs: 1,
      reconnectMaximumMs: 2,
      onHostRejected: () => {
        rejections++;
      },
    });
    connectors.push(connector);
    connector.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rejections).toBe(1);
    expect(attempts).toBe(1);
    expect(connector.doorway).toMatchObject({ state: "sign_in_required" });
  });

  it("keeps retrying a token failure that might clear on its own", async () => {
    const target = await listen(createServer((_request, response) => response.end("{}")));
    const gateway = await fakeGateway();
    let resolutions = 0;
    const connector = new PublicGatewayConnector({
      gatewayUrl: gateway.origin,
      hostId,
      installationId: "YWFhYWFhYWFhYWFhYWFhYQ",
      resolveHostToken: () => {
        resolutions += 1;
        return Promise.reject(new Error("account service is unavailable"));
      },
      tokenErrorIsTerminal: () => false,
      controlPlaneUrl: target,
      relayUrl: target,
      reconnectMinimumMs: 1,
      reconnectMaximumMs: 2,
    });
    connectors.push(connector);
    connector.start();

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(resolutions).toBeGreaterThan(1);
    expect(connector.doorway).toEqual({ state: "connecting" });
  });
});

interface FakeGatewayConnection {
  readonly socket: WebSocket;
  readonly request: import("node:http").IncomingMessage;
  nextFrame(): Promise<PublicGatewayTunnelFrame>;
  framesThrough(kind: PublicGatewayTunnelFrame["kind"]): Promise<PublicGatewayTunnelFrame[]>;
  send(frame: PublicGatewayTunnelFrame): void;
}

describe("push wakes over the same socket", () => {
  it("answers a wake with the gateway's status and carries ids only", async () => {
    const gateway = await fakeGateway();
    const connector = await startedConnector(gateway.origin);
    const connection = await gateway.nextConnection();

    const wake = connector.sendPushWake({
      wakeId: "3f4a0d1e-2b6c-4d7e-8f90-a1b2c3d4e5f6",
      deviceId: "device-1",
      conversationId: "conv-1",
      registrationId: "6f1f0f9a-4e7c-4a4f-9c1a-2b6d5f0a1c33",
      sequence: 5,
    });
    const frame = await connection.nextFrame();
    expect(frame).toEqual({
      schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
      kind: "push_wake",
      wakeId: "3f4a0d1e-2b6c-4d7e-8f90-a1b2c3d4e5f6",
      deviceId: "device-1",
      conversationId: "conv-1",
      registrationId: "6f1f0f9a-4e7c-4a4f-9c1a-2b6d5f0a1c33",
      sequence: 5,
    });
    // No host id: the gateway takes that from the authenticated socket.
    expect(JSON.stringify(frame)).not.toContain(hostId);
    connection.send({
      schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
      kind: "push_wake_result",
      wakeId: "3f4a0d1e-2b6c-4d7e-8f90-a1b2c3d4e5f6",
      status: "unregistered",
    });
    await expect(wake).resolves.toBe("unregistered");
  });

  it("reports unavailable when the socket drops before the gateway answers", async () => {
    const gateway = await fakeGateway();
    const connector = await startedConnector(gateway.origin);
    const connection = await gateway.nextConnection();

    const wake = connector.sendPushWake({
      wakeId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
      deviceId: "device-1",
      conversationId: "conv-1",
      registrationId: "6f1f0f9a-4e7c-4a4f-9c1a-2b6d5f0a1c33",
      sequence: 1,
    });
    await connection.nextFrame();
    connection.socket.close();
    await expect(wake).resolves.toBe("unavailable");
  });

  it("reports unavailable when the connector is closed, and never rejects a caller", async () => {
    const gateway = await fakeGateway();
    const connector = await startedConnector(gateway.origin);
    const connection = await gateway.nextConnection();

    const wake = connector.sendPushWake({
      wakeId: "1b2c3d4e-5f60-4718-9293-a4b5c6d7e8f9",
      deviceId: "device-1",
      conversationId: "conv-1",
      registrationId: "6f1f0f9a-4e7c-4a4f-9c1a-2b6d5f0a1c33",
      sequence: 1,
    });
    await connection.nextFrame();
    connector.close();
    await expect(wake).resolves.toBe("unavailable");
  });

  it("closes the socket when the gateway sends a host-owned wake frame", async () => {
    const gateway = await fakeGateway();
    await startedConnector(gateway.origin);
    const connection = await gateway.nextConnection();

    connection.send({
      schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
      kind: "push_wake",
      wakeId: "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
      deviceId: "device-1",
      conversationId: "conv-1",
      registrationId: "6f1f0f9a-4e7c-4a4f-9c1a-2b6d5f0a1c33",
      sequence: 1,
    });
    const [code] = (await once(connection.socket, "close")) as [number];
    expect(code).toBe(1008);
  });
});

/** A started connector pointed at a fake gateway, with loopback stubs behind it. */
async function startedConnector(gatewayOrigin: string): Promise<PublicGatewayConnector> {
  const control = await listen(createServer((_request, response) => response.end("{}")));
  const connector = new PublicGatewayConnector({
    gatewayUrl: gatewayOrigin,
    hostId,
    hostToken,
    controlPlaneUrl: control,
    relayUrl: control,
    reconnectMinimumMs: 5,
    reconnectMaximumMs: 10,
  });
  connectors.push(connector);
  connector.start();
  return connector;
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
