import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HostedBodyClient, HostedBodyResourceError } from "../src/hosted-body.ts";
import { createHostedPairing } from "../src/hosted-pairing.ts";
import type { CredentialStore, ProviderCredential } from "@clankie/credential-broker";
import { hostedFixture } from "./fixtures/hosted-body.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("accepts only fleet-signed state bound to the locally sent retry nonce and exact body digest", async () => {
  const f = hostedFixture(),
    nonces: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith("pairing-key")) return Response.json({ ok: true });
    const headers = new Headers(init?.headers);
    const nonce = headers.get("x-clankie-body-nonce")!;
    nonces.push(nonce);
    expect(headers.get("x-clankie-body-digest")).toBe(
      createHash("sha256").update(String(init?.body)).digest("base64url"),
    );
    expect(JSON.parse(String(init?.body))).toEqual({ installationId: f.bootstrap.installationId });
    if (nonces.length === 1) return Response.json({ error: "body_signature_invalid" }, { status: 401 });
    return Response.json({ state: f.security(nonce) });
  });
  const client = new HostedBodyClient(f.bootstrap, { clock: () => f.now, fetch: fetcher });
  await client.registerPairingKey(generateKeyPairSync("ed25519").privateKey);
  expect(await client.readSecurityState()).toEqual({ gen: 0, rev: [], ak: null, pk: null });
  expect(new Set(nonces).size).toBe(2);
});

it.each([
  "nonce",
  "tenant",
  "installation",
  "expiry",
  "future",
  "lifetime",
  "type",
  "signature",
  "malformed",
])("rejects invalid security state: %s", async (bad) => {
  const f = hostedFixture();
  const client = new HostedBodyClient(f.bootstrap, {
    clock: () => f.now,
    fetch: async (url, init) => {
      if (String(url).endsWith("pairing-key")) return Response.json({});
      const nonce = new Headers(init?.headers).get("x-clankie-body-nonce")!;
      const changed: Record<string, unknown> =
        bad === "nonce"
          ? { non: "n".repeat(22) }
          : bad === "tenant"
            ? { tid: `tn_${"b".repeat(20)}` }
            : bad === "installation"
              ? { inst: "z".repeat(22) }
              : bad === "expiry"
                ? { exp: f.now / 1000 }
                : bad === "future"
                  ? { iat: f.now / 1000 + 120, exp: f.now / 1000 + 180 }
                  : bad === "lifetime"
                    ? { exp: f.now / 1000 + 61 }
                    : bad === "type"
                      ? { typ: "clankie-host" }
                      : {};
      return Response.json({
        state:
          bad === "signature"
            ? hostedFixture().security(nonce)
            : bad === "malformed"
              ? "broken"
              : f.security(nonce, changed),
      });
    },
  });
  await client.registerPairingKey(generateKeyPairSync("ed25519").privateKey);
  await expect(client.readSecurityState()).rejects.toThrow();
});

it("replaces a retired pairing key, persists before registration, and does not park the body", async () => {
  const f = hostedFixture(),
    saved = new Map<string, ProviderCredential>();
  const store: CredentialStore = {
    get: async (provider) => saved.get(provider),
    set: async (provider, credential) => {
      saved.set(provider, credential);
    },
    delete: async (provider) => saved.delete(provider),
    list: async () => ({}),
  };
  let registrations = 0;
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (!String(url).endsWith("pairing-key")) return Response.json({});
    expect(saved.size).toBe(1);
    registrations++;
    return registrations === 1 ? Response.json({ error: "key_retired" }, { status: 403 }) : Response.json({});
  });
  const client = new HostedBodyClient(f.bootstrap, { clock: () => f.now, fetch: fetcher });
  const denied = vi.fn();
  client.onDenied = denied;
  const root = await mkdtemp(join(tmpdir(), "security-wire-"));
  roots.push(root);
  await createHostedPairing(client, store, join(root, "replay.json"));
  expect(registrations).toBe(2);
  expect(denied).not.toHaveBeenCalled();
  await expect(client.resolveHostToken()).resolves.toHaveProperty("token");
});

it("refuses a revoked wake device without rejecting the hosted account", async () => {
  const f = hostedFixture();
  const client = new HostedBodyClient(f.bootstrap, {
    clock: () => f.now,
    fetch: async (url) =>
      String(url).endsWith("pairing-key")
        ? Response.json({})
        : Response.json({ error: "device_revoked" }, { status: 403 }),
  });
  await client.registerPairingKey(generateKeyPairSync("ed25519").privateKey);
  await expect(client.registerWakeKey("device-revoked", "k")).rejects.toBeInstanceOf(HostedBodyResourceError);
  await expect(client.resolveHostToken()).resolves.toHaveProperty("token");
});
