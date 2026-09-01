import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { SUPERVISE_GRANTS, type OperatorConversationServiceRequest } from "@clankie/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createClankieApp, type ClankieApp, type TrustedOperatorIdentity } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { PublicGatewayConnector } from "../src/public-gateway-connector.ts";
import { createPublicGateway, type PublicGateway } from "../../gateway/src/gateway.ts";
import { ControlPlaneDeviceAuthorizer } from "../../relay/src/device-auth.ts";
import { createOperatorConversationRelayHandler } from "../../relay/src/operator-conversations.ts";

const HOST_ID = "mac_james_12345678";
const HOST_TOKEN = "gateway-host-token-that-is-longer-than-thirty-two-characters";
const DEVICE_KEY = Uint8Array.from(Buffer.alloc(32, 7));
const servers: Server[] = [];
const gateways: PublicGateway[] = [];
const connectors: PublicGatewayConnector[] = [];
const apps: ClankieApp[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const connector of connectors.splice(0)) connector.close();
  for (const app of apps.splice(0)) app.close();
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("public gateway product path", () => {
  it("pairs, authorizes chat, and streams terminal observation through AWS-shaped routing", async () => {
    const gateway = createPublicGateway({ hostTokens: new Map([[HOST_ID, HOST_TOKEN]]) });
    gateways.push(gateway);
    const gatewayOrigin = await listen(gateway.server);
    const hostBaseUrl = `${gatewayOrigin}/h/${HOST_ID}`;
    const directory = await mkdtemp(join(tmpdir(), "clankie-public-path-"));
    directories.push(directory);

    let connector: PublicGatewayConnector | undefined;
    const clankie = await createClankieApp({
      captain: createStubCaptain(),
      deviceSessionKey: DEVICE_KEY,
      eventLogPath: join(directory, "events.jsonl"),
      hostDisplayName: "James Mac",
      publicGatewayHostBaseUrl: hostBaseUrl,
      pairingOfferPublisher: {
        publishPairingOffer: (offer) => {
          if (connector === undefined) return Promise.reject(new Error("connector not ready"));
          return connector.publishPairingOffer(offer);
        },
      },
      authenticateOperator: operator,
    });
    apps.push(clankie);
    const controlServer = serve({ fetch: clankie.app.fetch, hostname: "127.0.0.1", port: 0 }) as Server;
    servers.push(controlServer);
    const controlOrigin = await listeningOrigin(controlServer);

    const relayHandler = createOperatorConversationRelayHandler({
      authorizeDevice: new ControlPlaneDeviceAuthorizer({ baseUrl: controlOrigin }),
      tailMaxPages: 1,
      dispatch: dispatch,
    });
    const relayServer = createServer((request, response) => {
      void relayHandler(request, response).then((handled) => {
        if (handled) return;
        response.statusCode = 404;
        response.end();
      });
    });
    const relayOrigin = await listen(relayServer);

    connector = new PublicGatewayConnector({
      gatewayUrl: gatewayOrigin,
      hostId: HOST_ID,
      hostToken: HOST_TOKEN,
      controlPlaneUrl: controlOrigin,
      relayUrl: relayOrigin,
    });
    connectors.push(connector);
    connector.start();

    const offerResponse = await fetch(`${controlOrigin}/v1/pairing/offer`, {
      method: "POST",
      headers: { authorization: "Bearer operator-secret", "content-type": "application/json" },
      body: "{}",
    });
    expect(offerResponse.status).toBe(200);
    const offer = (await offerResponse.json()) as { readonly deepLink: string };
    const offerSecret = new URL(offer.deepLink).searchParams.get("offer");
    expect(offerSecret).toBeTruthy();

    const redeem = await fetch(`${gatewayOrigin}/v1/pairing/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offerSecret, device: { name: "James iPhone", platform: "ios" } }),
    });
    expect(redeem.status).toBe(200);
    const redeemed = (await redeem.json()) as {
      readonly completionToken: string;
      readonly hostBaseUrl: string;
    };
    expect(redeemed.hostBaseUrl).toBe(hostBaseUrl);

    const complete = await fetch(`${redeemed.hostBaseUrl}/v1/pairing/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ completionToken: redeemed.completionToken, acceptedGrants: SUPERVISE_GRANTS }),
    });
    expect(complete.status).toBe(200);
    const completed = (await complete.json()) as { readonly deviceToken: string; readonly relayUrl: string };
    expect(completed.relayUrl).toBe(hostBaseUrl);

    const headers = { authorization: `Bearer ${completed.deviceToken}`, "content-type": "application/json" };
    const conversations = await fetch(`${completed.relayUrl}/operator/v1/dispatch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ op: "list", schemaVersion: 1 }),
    });
    expect(await conversations.json()).toEqual({ op: "list", schemaVersion: 1, conversations: [] });

    const terminal = await fetch(`${completed.relayUrl}/operator/v1/terminal-tail`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        op: "terminal_tail",
        schemaVersion: 1,
        observation: {
          schemaVersion: 1,
          terminalId: "term-worker",
          surfaceClientId: "native-ios",
          columns: 120,
          rows: 40,
          limit: 1,
        },
      }),
    });
    expect(terminal.status).toBe(200);
    expect((await terminal.text()).trim()).toContain('"kind":"frame"');
  });
});

function operator(request: Request): Promise<TrustedOperatorIdentity | undefined> {
  return Promise.resolve(
    request.headers.get("authorization") === "Bearer operator-secret"
      ? { operatorId: "operator-james" }
      : undefined,
  );
}

function dispatch(request: OperatorConversationServiceRequest) {
  if (request.op === "list")
    return Promise.resolve({ op: "list" as const, schemaVersion: 1 as const, conversations: [] });
  if (request.op !== "terminal_tail") return Promise.reject(new Error(`unexpected ${request.op}`));
  return Promise.resolve({
    op: "terminal_tail" as const,
    schemaVersion: 1 as const,
    result: {
      schemaVersion: 1 as const,
      status: "page" as const,
      terminalId: request.observation.terminalId,
      surfaceClientId: request.observation.surfaceClientId,
      cursor: { streamId: "stream-1", sequence: 1 },
      frames: [
        {
          schemaVersion: 1 as const,
          type: "terminal.frame" as const,
          terminalId: request.observation.terminalId,
          sequence: 1,
          encoding: "base64" as const,
          data: "G1sySg==",
          columns: 120,
          rows: 40,
          full: true,
        },
      ],
      hasMore: false,
    },
  });
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  return await listeningOrigin(server);
}

async function listeningOrigin(server: Server): Promise<string> {
  if (!server.listening) await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}
