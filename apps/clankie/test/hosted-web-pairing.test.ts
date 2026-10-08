import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createGatewayEncryptedFetch,
  createWebGatewayCrypto,
} from "../../../packages/api-client/src/gateway-encryption.ts";
import { GatewayEncryptionCredentialSchema } from "@clankie/protocol/gateway-encryption";
import { createHostedAccountClient } from "@clankie/protocol/hosted-pairing";
import {
  PairingCompleteResponseSchema,
  PairingRedeemResponseSchema,
  TAKE_CONTROL_GRANTS,
} from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { createClankieApp, type ClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { HostedBodyClient } from "../src/hosted-body.ts";
import { HostedPairing } from "../src/hosted-pairing.ts";
import { GatewayEncryptionHost, openGatewayValue, sealGatewayValue } from "../src/gateway-encryption.ts";
import { hostedFixture } from "./fixtures/hosted-body.ts";

// The browser side here uses only globalThis.crypto.subtle, as app.clankie.bot does.
const apps: ClankieApp[] = [],
  roots: string[] = [];
afterEach(async () => {
  apps.splice(0).forEach((app) => app.close());
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("WebCrypto gateway records open with the body's node:crypto implementation, and the reverse", async () => {
  const web = createWebGatewayCrypto(),
    raw = randomBytes(32),
    key = raw.toString("base64"),
    aad = "clankie-gateway-v1:aad";
  const text = "héllo 🦀 browser";
  const sealed = await web.seal(key, text, aad);
  expect(Buffer.from(sealed, "base64").length).toBe(12 + Buffer.byteLength(text) + 16);
  expect(openGatewayValue(raw, sealed, aad)).toBe(text);
  expect(await web.open(key, sealGatewayValue(raw, text, aad), aad)).toBe(text);
  await expect(web.open(key, sealGatewayValue(raw, text, aad), `${aad}x`)).rejects.toThrow();
  expect(() => openGatewayValue(raw, sealed, `${aad}x`)).toThrow();
});

async function fixture(tamper = false) {
  const f = hostedFixture();
  vi.spyOn(Date, "now").mockReturnValue(f.now);
  const root = await mkdtemp(join(tmpdir(), "hosted-web-"));
  roots.push(root);
  const bodyKey = generateKeyPairSync("ed25519");
  const hostedPairing = new HostedPairing(
    new HostedBodyClient(f.bootstrap, { clock: () => f.now }),
    bodyKey.privateKey,
    { clock: () => f.now },
  );
  const encryption = new GatewayEncryptionHost(f.hostId, randomBytes(32));
  const app = await createClankieApp({
    captain: createStubCaptain(),
    hostedPairing,
    settings: new SettingsStore(join(root, "body-settings.json")),
    deviceSessionKey: randomBytes(32),
    clock: () => new Date(f.now),
    authenticateOperator: async () => undefined,
    pairingOfferPublisher: {
      publishPairingOffer: async () => {},
      protectPairingOffer: (offer) => ({
        version: 1,
        deepLink: `clankie://connect?v=1&offer=${offer.offerSecret}#${new URLSearchParams(encryption.pairingCredential(offer))}`,
        code: offer.code,
        expiresAt: offer.expiresAt,
      }),
    },
  });
  apps.push(app);
  const wire: string[] = [];
  const machine = { id: "machine-1", name: "My hosted Clankie", hostId: f.hostId, state: "running" };
  // Fleet account routes and the gateway; the body's answer and encryption are the production code.
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = new Request(input, init),
      url = new URL(req.url),
      body = await req.text();
    wire.push(body);
    if (url.pathname === "/fleet/v1/machines") return Response.json({ machines: [machine] });
    if (url.pathname === "/fleet/v1/pairing/offer") {
      const binding = JSON.parse(body) as { browserPublicKey: string; nonce: string };
      const pairTicket = f.pair({
        bkh: createHash("sha256")
          .update(Buffer.from(binding.browserPublicKey, "base64url"))
          .digest("base64url"),
        non: binding.nonce,
      });
      const response = await app.app.request("/v1/hosted/pair-offer", {
        method: "POST",
        body: JSON.stringify({
          version: 2,
          pairTicket,
          browserPublicKey: binding.browserPublicKey,
          nonce: binding.nonce,
        }),
      });
      const answer = (await response.json()) as Record<string, unknown>;
      return Response.json({
        machine,
        ticketId: "j".repeat(22),
        bodyPairingKey: bodyKey.publicKey.export({ format: "jwk" }).x,
        answer: tamper ? { ...answer, signature: randomBytes(64).toString("base64url") } : answer,
      });
    }
    return encryption.handle(url.pathname.slice(`/h/${f.hostId}`.length), body, req.signal, async (request) =>
      app.app.fetch(request),
    );
  };
  return { f, fetchImpl, wire };
}

it("a browser pairs with a hosted body through WebCrypto alone and uses the encrypted gateway", async () => {
  const { f, fetchImpl, wire } = await fixture();
  const account = createHostedAccountClient({
    origin: "https://api.example.test",
    accessToken: "account-only-secret",
    fetchImpl,
  });
  const [machine] = await account.machines();
  const paired = await account.pair(machine!);
  expect(paired.encryption.hostId).toBe(f.hostId);
  let encryption = paired.encryption;
  const rotate = (response: Response) =>
    GatewayEncryptionCredentialSchema.parse({
      hostId: encryption.hostId,
      key: response.headers.get("x-clankie-encryption-key"),
      ticket: response.headers.get("x-clankie-encryption-ticket"),
    });
  const secureFetch = createGatewayEncryptedFetch({
    crypto: createWebGatewayCrypto(),
    fetchImpl,
    credential: () => encryption,
  });
  const base = `https://api.example.test/h/${f.hostId}`;
  const redeemResponse = await secureFetch(`${base}/v1/pairing/redeem`, {
    method: "POST",
    body: JSON.stringify({
      offerSecret: new URL(paired.link).searchParams.get("offer"),
      device: { name: "Browser", platform: "unknown" },
    }),
  });
  expect(redeemResponse.status).toBe(200);
  const redeem = PairingRedeemResponseSchema.parse(await redeemResponse.json());
  encryption = rotate(redeemResponse);
  const completeResponse = await secureFetch(`${base}/v1/pairing/complete`, {
    method: "POST",
    body: JSON.stringify({ completionToken: redeem.completionToken, acceptedGrants: TAKE_CONTROL_GRANTS }),
  });
  expect(completeResponse.status).toBe(200);
  const complete = PairingCompleteResponseSchema.parse(await completeResponse.json());
  encryption = rotate(completeResponse);
  const self = await secureFetch(`${base}/v1/devices/self`, {
    headers: { authorization: `Bearer ${complete.deviceToken}` },
  });
  expect(self.status).toBe(200);
  expect(await self.json()).toMatchObject({ deviceId: complete.deviceId });
  const seen = wire.join("\n");
  for (const secret of [paired.link, complete.deviceToken, paired.encryption.key, encryption.key])
    expect(seen).not.toContain(secret);
});

it("the WebCrypto exchange refuses an answer the body did not sign", async () => {
  const { fetchImpl } = await fixture(true);
  const account = createHostedAccountClient({
    origin: "https://api.example.test",
    accessToken: "a",
    fetchImpl,
  });
  const [machine] = await account.machines();
  await expect(account.pair(machine!)).rejects.toThrow("Hosted pairing answer is unauthenticated");
});
