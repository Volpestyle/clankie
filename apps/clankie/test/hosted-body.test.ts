import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { derivePublicGatewayHostId } from "@clankie/protocol/public-gateway";
import { describe, expect, it, vi } from "vitest";
import { HostedBodyClient, HostedBodyDeniedError, readHostedBodyBootstrap } from "../src/hosted-body.ts";

export function hostedFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const kid = createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("base64url")
    .slice(0, 16);
  const now = 1_790_000_000_000;
  const accountId = "account-1",
    installationId = "i".repeat(22),
    tenantId = `tn_${"a".repeat(20)}`;
  const hostId = derivePublicGatewayHostId(accountId, installationId);
  const token = (typ: string, claims: Record<string, unknown>) => {
    const data = [
      { alg: "EdDSA", typ, kid },
      { iss: "clankie-fleet", tid: tenantId, hid: hostId, iat: now / 1000, ...claims },
    ]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
      .join(".");
    return `${data}.${sign(null, Buffer.from(data), privateKey).toString("base64url")}`;
  };
  const host = (iat = now / 1000) =>
    token("clankie-host", {
      aud: "clankie-gateway",
      sub: accountId,
      inst: installationId,
      iat,
      exp: iat + 21600,
    });
  const pair = (claims: Record<string, unknown> = {}) =>
    token("clankie-pair", { aud: "clankie-body", jti: "j".repeat(22), exp: now / 1000 + 120, ...claims });
  const bootstrap = {
    hostCredential: host(),
    credentialExpiresAtMs: now + 21600000,
    gatewayOrigin: "https://api.example.test",
    accountId,
    installationId,
    tenantId,
    fleetVerifyKeysJson: JSON.stringify({
      keys: [{ publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) }],
    }),
  };
  return { now, bootstrap, host, pair, hostId };
}

describe("managed hosted credential", () => {
  it("is opt-in and rejects malformed or insecure bootstrap configuration", () => {
    expect(readHostedBodyBootstrap({})).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), "hosted-bootstrap-"));
    try {
      const path = join(dir, "bootstrap.json");
      const { bootstrap } = hostedFixture();
      writeFileSync(path, JSON.stringify(bootstrap));
      expect(readHostedBodyBootstrap({ CLANKIE_HOSTED_BOOTSTRAP_FILE: path })).toEqual(bootstrap);
      writeFileSync(path, JSON.stringify({ ...bootstrap, gatewayOrigin: "http://example.test" }));
      expect(() => readHostedBodyBootstrap({ CLANKIE_HOSTED_BOOTSTRAP_FILE: path })).toThrow(
        "Invalid hosted body bootstrap file",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("shares a single half-life renewal across connector and fleet calls and persists it", async () => {
    const f = hostedFixture();
    let now = f.now;
    const persist = vi.fn(async () => {});
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("host-credential")
        ? Response.json({ credential: f.host(now / 1000), expiresAtMs: now + 21600000 })
        : Response.json({}),
    );
    const client = new HostedBodyClient(f.bootstrap, { fetch: fetcher, clock: () => now, persist });
    expect((await client.resolveHostToken()).token).toBe(f.bootstrap.hostCredential);
    expect(fetcher).not.toHaveBeenCalled();
    now += 10800000;
    const [next] = await Promise.all([
      client.resolveHostToken(),
      client.registerWakeKey("device-one", "public-key"),
    ]);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("host-credential"))).toHaveLength(1);
    expect(persist).toHaveBeenCalledWith(next.token, next.expiresAt);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      headers: { authorization: `Bearer ${next.token}` },
      body: JSON.stringify({
        deviceId: "device-one",
        publicKey: "public-key",
        installationId: f.bootstrap.installationId,
      }),
    });
    await client.revokeWakeKey("device-one");
    expect(String(fetcher.mock.calls[2]?.[0])).toContain("/fleet/v1/body/wake-keys/revoke");
  });
  it("parks on 403 and never sends another request", async () => {
    const f = hostedFixture();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 403 }));
    const client = new HostedBodyClient(f.bootstrap, { fetch: fetcher, clock: () => f.now + 10800000 });
    client.onDenied = vi.fn();
    await expect(client.resolveHostToken()).rejects.toBeInstanceOf(HostedBodyDeniedError);
    await expect(client.registerWakeKey("device-one", "key")).rejects.toBeInstanceOf(HostedBodyDeniedError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(client.onDenied).toHaveBeenCalledTimes(1);
  });
  it("checks signature, audience, tenant, host, expiry and bounded lifetime of pair tickets", () => {
    const f = hostedFixture(),
      client = new HostedBodyClient(f.bootstrap, { clock: () => f.now });
    expect(client.verifyPairTicket(f.pair()).jti).toBe("j".repeat(22));
    for (const claims of [
      { aud: "clankie-gateway" },
      { tid: `tn_${"b".repeat(20)}` },
      { hid: "x".repeat(43) },
      { exp: f.now / 1000 },
      { exp: f.now / 1000 + 121 },
      { iat: f.now / 1000 + 61 },
    ])
      expect(() => client.verifyPairTicket(f.pair(claims))).toThrow();
    expect(() => client.verifyPairTicket(hostedFixture().pair())).toThrow();
  });
});
