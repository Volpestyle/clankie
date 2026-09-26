import {
  createDecipheriv,
  createECDH,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  verify,
} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialStore, ProviderCredential } from "@clankie/credential-broker";
import { createClankieApp, type ClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { HostedBodyClient } from "../src/hosted-body.ts";
import { HostedPairing, createHostedPairing } from "../src/hosted-pairing.ts";
import { PublicGatewayConnector } from "../src/public-gateway-connector.ts";
import { hostedFixture } from "./fixtures/hosted-body.ts";
const apps: ClankieApp[] = [],
  dirs: string[] = [];
afterEach(() => {
  apps.splice(0).forEach((app) => app.close());
  dirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});
function setup() {
  const f = hostedFixture(),
    client = new HostedBodyClient(f.bootstrap, { clock: () => f.now });
  const signing = generateKeyPairSync("ed25519"),
    browser = createECDH("prime256v1");
  const browserPublicKey = browser.generateKeys().toString("base64url");
  const bkh = createHash("sha256").update(Buffer.from(browserPublicKey, "base64url")).digest("base64url");
  const request = { version: 2, pairTicket: f.pair({ bkh }), browserPublicKey, nonce: f.nonce };
  const dir = mkdtempSync(join(tmpdir(), "hosted-pairing-"));
  dirs.push(dir);
  const replayPath = join(dir, "used.json");
  const options = { replayPath, clock: () => f.now };
  const pairing = new HostedPairing(client, signing.privateKey, options);
  return { f, client, signing, browser, request, pairing, options, replayPath, bkh };
}
function transcript(
  hostId: string,
  request: ReturnType<typeof setup>["request"],
  response: Record<string, string>,
  jti = "j".repeat(22),
) {
  return Buffer.from(
    [
      "clankie-hosted-pair-v2",
      hostId,
      jti,
      request.browserPublicKey,
      request.nonce,
      response.ephemeralPublicKey,
      response.iv,
      response.ciphertext,
    ].join("\n"),
  );
}
describe("hosted pairing v2", () => {
  it("signs and seals the real ADR 0173 offer, and never exposes its link on the wire", async () => {
    const { f, signing, browser, request, pairing } = setup();
    const connector = new PublicGatewayConnector({
      gatewayUrl: f.bootstrap.gatewayOrigin,
      hostId: f.hostId,
      hostToken: "t".repeat(32),
      encryptionKey: randomBytes(32),
      controlPlaneUrl: "http://127.0.0.1:4310",
      relayUrl: "http://127.0.0.1:4321",
    });
    const onHostedPairing = vi.fn();
    const app = await createClankieApp({
      captain: createStubCaptain(),
      hostedPairing: pairing,
      onHostedPairing,
      clock: () => new Date(f.now),
      deviceSessionKey: randomBytes(32),
      pairingOfferPublisher: {
        publishPairingOffer: async () => {},
        protectPairingOffer: (offer) => connector.protectPairingOffer(offer),
      },
    });
    apps.push(app);
    const response = await app.app.request("/v1/hosted/pair-offer", {
      method: "POST",
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const sealed = await response.json();
    expect(sealed.version).toBe(2);
    expect(JSON.stringify(sealed)).not.toContain("clankie://");
    expect(
      verify(
        null,
        transcript(f.hostId, request, sealed),
        signing.publicKey,
        Buffer.from(sealed.signature, "base64url"),
      ),
    ).toBe(true);
    const info = `clankie-hosted-pair-v2\n${f.hostId}`;
    const key = hkdfSync(
      "sha256",
      browser.computeSecret(Buffer.from(sealed.ephemeralPublicKey, "base64url")),
      Buffer.from(request.nonce, "base64url"),
      info,
      32,
    );
    const ciphertext = Buffer.from(sealed.ciphertext, "base64url"),
      decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(sealed.iv, "base64url"));
    decipher.setAAD(Buffer.from(info));
    decipher.setAuthTag(ciphertext.subarray(-16));
    const offer = JSON.parse(
      Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString(),
    ) as { link: string; expiresAtMs: number };
    const link = new URL(offer.link),
      anchor = new URLSearchParams(link.hash.slice(1));
    expect(anchor.get("hostId")).toBe(f.hostId);
    expect(anchor.get("key")).toBeTruthy();
    expect(anchor.get("ticket")).toBeTruthy();
    expect(offer.expiresAtMs).toBe(f.now + 300000);
    expect(onHostedPairing).toHaveBeenCalledTimes(1);
    const redeemed = await app.app.request("/v1/pairing/redeem", {
      method: "POST",
      body: JSON.stringify({
        offerSecret: link.searchParams.get("offer"),
        device: { name: "Phone", platform: "ios" },
      }),
    });
    expect(redeemed.status).toBe(200);
    // An active gateway cannot substitute any signed response field or another request/host.
    for (const field of ["ephemeralPublicKey", "iv", "ciphertext"] as const)
      expect(
        verify(
          null,
          transcript(f.hostId, request, { ...sealed, [field]: `${sealed[field]}A` }),
          signing.publicKey,
          Buffer.from(sealed.signature, "base64url"),
        ),
      ).toBe(false);
    expect(
      verify(
        null,
        transcript("other-host", request, sealed),
        signing.publicKey,
        Buffer.from(sealed.signature, "base64url"),
      ),
    ).toBe(false);
    expect(
      verify(
        null,
        transcript(f.hostId, request, sealed, "k".repeat(22)),
        signing.publicKey,
        Buffer.from(sealed.signature, "base64url"),
      ),
    ).toBe(false);
  });
  it("refuses browser-key/nonce substitution, v1, bad tickets and replay before minting", async () => {
    const { f, request, pairing, client, signing, options, replayPath } = setup();
    const mint = vi.fn(async () => ({ link: "clankie://connect?secret", expiresAtMs: f.now + 300000 }));
    const stranger = createECDH("prime256v1").generateKeys().toString("base64url");
    for (const changed of [
      { browserPublicKey: stranger },
      { nonce: randomBytes(16).toString("base64url") },
      { pairTicket: "bad" },
      { version: 1 },
    ])
      expect((await pairing.offer({ ...request, ...changed }, mint)).status).toBe(401);
    expect(mint).not.toHaveBeenCalled();
    const responses = await Promise.all([pairing.offer(request, mint), pairing.offer(request, mint)]);
    expect(responses.map((response) => response.status)).toEqual([200, 401]);
    expect((await new HostedPairing(client, signing.privateKey, options).offer(request, mint)).status).toBe(
      401,
    );
    expect(mint).toHaveBeenCalledTimes(1);
    const disk = readFileSync(replayPath, "utf8");
    expect(disk).not.toContain("secret");
    expect(disk).not.toContain(request.pairTicket);
  });
  it("retains its rate limit across service restart", async () => {
    const { f, request, client, signing, options, bkh } = setup();
    const mint = vi.fn(async () => ({ link: "clankie://connect", expiresAtMs: f.now + 300000 }));
    for (let i = 0; i < 6; i++) {
      const response = await new HostedPairing(client, signing.privateKey, options).offer(
        { ...request, pairTicket: f.pair({ bkh, jti: String(i).repeat(22) }) },
        mint,
      );
      expect(response.status).toBe(i < 5 ? 200 : 429);
    }
    expect(mint).toHaveBeenCalledTimes(5);
  });
  it("reuses the broker key and registers directly with fleet on every boot", async () => {
    const { f, replayPath } = setup();
    const entries = new Map<string, ProviderCredential>();
    const store: CredentialStore = {
      get: async (id) => entries.get(id),
      set: async (id, value) => {
        entries.set(id, value);
      },
      delete: async (id) => entries.delete(id),
      list: async () => ({}),
    };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    const client = new HostedBodyClient(f.bootstrap, { clock: () => f.now, fetch: fetcher });
    await createHostedPairing(client, store, replayPath);
    await createHostedPairing(client, store, replayPath);
    expect(entries.size).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const first = fetcher.mock.calls[0]!,
      second = fetcher.mock.calls[1]!;
    expect(String(first[0])).toBe("https://api.example.test/fleet/v1/body/pairing-key");
    expect(first[1]?.body).toBe(second[1]?.body);
    const body = JSON.parse(String(first[1]?.body));
    expect(body).toMatchObject({
      installationId: f.bootstrap.installationId,
      registrationToken: f.bootstrap.pairingKeyRegistrationToken,
    });
    expect(body.publicKey).toHaveLength(43);
    const stored = [...entries.values()][0]!;
    if (stored.type !== "api") throw new Error("wrong credential");
    expect(body.publicKey).toBe(createPublicKey(stored.key).export({ format: "jwk" }).x);
    expect(first[1]).toMatchObject({
      redirect: "error",
      headers: { authorization: `Bearer ${f.bootstrap.hostCredential}` },
    });
    expect(String(first[1]?.body)).not.toContain("PRIVATE KEY");
  });
});
