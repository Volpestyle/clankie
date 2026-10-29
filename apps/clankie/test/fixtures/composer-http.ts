import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { expect } from "vitest";
import { SUPERVISE_GRANTS, type DeviceGrantSet } from "@clankie/protocol";
import { derivePublicGatewayHostId } from "@clankie/protocol/public-gateway";
import { type GatewayEncryptionCredential } from "@clankie/protocol/gateway-encryption";
import { createComposerTranscriptionApi } from "../../../../packages/api-client/src/composer-transcription.ts";
import { createGatewayEncryptedFetch } from "../../../../packages/api-client/src/gateway-encryption.ts";
import { ComposerTranscriptions } from "../../src/composer-transcription.ts";
import { createClankieApp } from "../../src/app.ts";
import { createStubCaptain } from "../../src/captain/port.ts";
import { GatewayEncryptionHost, sealGatewayValue, openGatewayValue } from "../../src/gateway-encryption.ts";

const closes: Array<() => Promise<void>> = [];
export async function closeComposerFixtures() {
  for (const close of closes.splice(0).reverse()) await close();
}
async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_address");
  closes.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  return `http://127.0.0.1:${address.port}`;
}
export async function composerHttpFixture() {
  const root = mkdtempSync(join(tmpdir(), "composer-http-"));
  closes.push(async () => rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  const key = randomBytes(32),
    installationId = "i".repeat(22),
    hostId = derivePublicGatewayHostId("fixture-owner", installationId);
  const host = new GatewayEncryptionHost(hostId, randomBytes(32));
  let credential!: GatewayEncryptionCredential;
  const app = await createClankieApp({
    captain: createStubCaptain(),
    eventLogPath: join(root, "events.jsonl"),
    clock: () => new Date(now),
    deviceSessionKey: key,
    authenticateOperator: async (request) => {
      const authorization = request.headers.get("authorization");
      if (authorization === "Bearer owner") return { operatorId: "fixture-owner" };
      return undefined;
    },
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer captain"
        ? { captainId: "fixture-captain" }
        : undefined,
    pairingOfferPublisher: {
      publishPairingOffer: async (offer) => {
        credential = host.pairingCredential(offer);
      },
    },
    composerTranscriptions: new ComposerTranscriptions({ root: join(root, "composer"), clock: () => now }),
  });
  closes.push(async () => app.close());
  const bodyUrl = await listen(
    serve({ fetch: (request) => app.app.fetch(request), hostname: "127.0.0.1", port: 0 }) as Server,
  );
  const door = await listen(
    createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      const path = (req.url ?? "").replace(`/h/${hostId}`, "");
      const response = await host.handle(path, raw, new AbortController().signal, async (request) =>
        app.app.fetch(request),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    }),
  );
  const base = `${door}/h/${hostId}`;
  const encrypted = createGatewayEncryptedFetch({
    credential: () => credential,
    crypto: {
      randomBytes,
      seal: async (k, text, aad) => sealGatewayValue(Buffer.from(k, "base64"), text, aad),
      open: async (k, text, aad) => openGatewayValue(Buffer.from(k, "base64"), text, aad),
    },
  });
  const finishPairing = async (completionToken: string, grants: DeviceGrantSet = SUPERVISE_GRANTS) => {
    const complete = await encrypted(`${base}/v1/pairing/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ completionToken, acceptedGrants: grants }),
    });
    const device = await complete.json();
    if (!complete.ok)
      throw Object.assign(new Error(device.error), { status: complete.status, completionToken });
    credential.ticket = complete.headers.get("x-clankie-encryption-ticket")!;
    credential.key = complete.headers.get("x-clankie-encryption-key")!;
    return { deviceId: device.deviceId as string, token: device.deviceToken as string };
  };
  const pair = async (
    grants: DeviceGrantSet = SUPERVISE_GRANTS,
    ownerToken = "owner",
    supportGrantId?: string,
  ) => {
    const offer = await (
      await fetch(
        `${bodyUrl}${supportGrantId === undefined ? "/v1/pairing/offer" : `/v1/support/grants/${supportGrantId}/pairing-offer`}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${ownerToken}` },
        },
      )
    ).json();
    const offerSecret = new URL(offer.deepLink).searchParams.get("offer");
    const redeem = await encrypted(`${base}/v1/pairing/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offerSecret, device: { name: "Fixture phone", platform: "ios" } }),
    });
    const pending = await redeem.json();
    if (!redeem.ok) throw Object.assign(new Error(pending.error), { status: redeem.status });
    credential.ticket = redeem.headers.get("x-clankie-encryption-ticket")!;
    return finishPairing(pending.completionToken, grants);
  };
  const device = await pair();
  const api = createComposerTranscriptionApi({
    request: async (method, path, body, signal) => {
      const response = await encrypted(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${device.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
      });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
      return result;
    },
  });
  return {
    root,
    api,
    device,
    key,
    bodyUrl,
    pair,
    createSupportGrant: async (durationSeconds = 600) => {
      const response = await fetch(`${bodyUrl}/v1/support/grants`, {
        method: "POST",
        headers: { authorization: "Bearer owner", "content-type": "application/json" },
        body: JSON.stringify({ scope: "read-state", durationSeconds, supportRef: "composer-test" }),
      });
      expect(response.status).toBe(200);
      return (await response.json()).grantId as string;
    },
    now: () => now,
  };
}
