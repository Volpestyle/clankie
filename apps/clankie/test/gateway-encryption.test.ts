import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUPERVISE_GRANTS } from "@clankie/protocol";
import { derivePublicGatewayHostId } from "@clankie/protocol/public-gateway";
import {
  GATEWAY_ENCRYPTED_PATH,
  type GatewayEncryptionCredential,
} from "@clankie/protocol/gateway-encryption";
import {
  createGatewayEncryptedFetch,
  type GatewayCrypto,
} from "../../../packages/api-client/src/gateway-encryption.ts";
import { GatewayEncryptionHost, openGatewayValue, sealGatewayValue } from "../src/gateway-encryption.ts";
import { createClankieApp, type ClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";

const crypto: GatewayCrypto = {
  randomBytes,
  seal: async (key, text, aad) => sealGatewayValue(Buffer.from(key, "base64"), text, aad),
  open: async (key, text, aad) => openGatewayValue(Buffer.from(key, "base64"), text, aad),
};
const apps: ClankieApp[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function account(
  accountId: string,
  applicationResponse: () => Response = () =>
    new Response(new Uint8Array([0, 255, 27, 65]), {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="proof.bin"',
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    }),
) {
  const hostId = derivePublicGatewayHostId(accountId, "i".repeat(22));
  const master = randomBytes(32);
  let host = new GatewayEncryptionHost(hostId, master);
  let credential: GatewayEncryptionCredential;
  const base = `http://127.0.0.1/h/${hostId}`;
  const app = await createClankieApp({
    captain: createStubCaptain(),
    deviceSessionKey: randomBytes(32),
    publicGatewayHostBaseUrl: base,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: accountId } : undefined,
    pairingOfferPublisher: {
      publishPairingOffer: async (offer) => {
        credential = host.pairingCredential(offer);
      },
    },
  });
  apps.push(app);
  const outerRequests: { path: string; init: RequestInit }[] = [];
  let dispatched = 0;
  const forward = async (request: Request): Promise<Response> => {
    if (new URL(request.url).hostname === "control") return app.app.fetch(request);
    dispatched++;
    return applicationResponse();
  };
  const raw: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.slice(`/h/${hostId}`.length);
    outerRequests.push({ path, init: { ...init } });
    return host.handle(path, String(init?.body ?? ""), init?.signal ?? new AbortController().signal, forward);
  };
  const client = createGatewayEncryptedFetch({ crypto, fetchImpl: raw, credential: () => credential });
  const offer = await (
    await app.app.request("/v1/pairing/offer", { method: "POST", headers: { authorization: "Bearer owner" } })
  ).json();
  const offerSecret = new URL(offer.deepLink).searchParams.get("offer");
  const redeem = await client(`${base}/v1/pairing/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ offerSecret, device: { name: "Phone", platform: "ios" } }),
  });
  expect(redeem.status).toBe(200);
  credential!.ticket = redeem.headers.get("x-clankie-encryption-ticket")!;
  const pending = await redeem.json();
  const complete = await client(`${base}/v1/pairing/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ completionToken: pending.completionToken, acceptedGrants: SUPERVISE_GRANTS }),
  });
  expect(complete.status).toBe(200);
  credential!.ticket = complete.headers.get("x-clankie-encryption-ticket")!;
  credential!.key = complete.headers.get("x-clankie-encryption-key")!;
  const device = await complete.json();
  const headers = { authorization: `Bearer ${device.deviceToken}`, "content-type": "application/json" };
  return {
    app,
    base,
    headers,
    device,
    client,
    raw,
    outerRequests,
    getCredential: () => credential!,
    getDispatched: () => dispatched,
    restart: (rotate = false) => {
      host = new GatewayEncryptionHost(hostId, rotate ? randomBytes(32) : master);
    },
  };
}

describe("device-to-host encryption security boundary", () => {
  it("decodes UTF-8 without changing the encrypted response bytes or metadata", async () => {
    const NativeResponse = Response;
    vi.stubGlobal(
      "Response",
      class ReactNativeResponse extends NativeResponse {
        public override async text(): Promise<string> {
          return Array.from(new Uint8Array(await this.arrayBuffer()), (byte) =>
            String.fromCharCode(byte),
          ).join("");
        }
      },
    );
    const bytes = new TextEncoder().encode('{"name":"Renaming… ⠼"}');
    const actor = await account(
      "utf8-account",
      () =>
        new Response(bytes, {
          status: 206,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
    );

    const response = await actor.client(`${actor.base}/operator/v1/dispatch`, {
      method: "POST",
      headers: actor.headers,
      body: "{}",
    });

    expect(await response.clone().json()).toEqual({ name: "Renaming… ⠼" });
    expect(new Uint8Array(await response.clone().arrayBuffer())).toEqual(bytes);
    expect(new Uint8Array(await (await response.clone().blob()).arrayBuffer())).toEqual(bytes);
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const emptyActor = await account("empty-account", () => new Response(null, { status: 204 }));
    const empty = await emptyActor.client(`${emptyActor.base}/operator/v1/dispatch`, {
      method: "POST",
      headers: emptyActor.headers,
      body: "{}",
    });
    expect(empty.status).toBe(204);
    expect(empty.body).toBeNull();
    expect(await empty.text()).toBe("");
  });

  it("authenticates two unrelated account/host pairings, hides all application bytes, rejects cross-device and cross-host credentials", async () => {
    const alice = await account("unrelated-alice");
    const bob = await account("unrelated-bob");
    for (const actor of [alice, bob]) {
      const response = await actor.client(`${actor.base}/operator/v1/dispatch`, {
        method: "POST",
        headers: actor.headers,
        body: '{"private":"conversation-secret"}',
      });
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255, 27, 65]));
      expect(response.headers.get("content-disposition")).toBe('attachment; filename="proof.bin"');
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      const wire = JSON.stringify(actor.outerRequests);
      expect(wire).not.toContain(actor.device.deviceToken);
      expect(wire).not.toContain("conversation-secret");
      expect(wire).not.toContain(actor.getCredential().key);
      expect(actor.outerRequests.every((r) => !new Headers(r.init.headers).has("authorization"))).toBe(true);
    }
    await expect(alice.client(`${bob.base}/v1/devices/self`, { headers: bob.headers })).rejects.toThrow(
      "identity mismatch",
    );
    const substitution = createGatewayEncryptedFetch({
      crypto,
      credential: alice.getCredential,
      fetchImpl: bob.raw,
    });
    await expect(substitution(`${alice.base}/v1/devices/self`, { headers: alice.headers })).rejects.toThrow();
    const wrongDevice = await alice.client(`${alice.base}/v1/devices/self`, { headers: bob.headers });
    expect(wrongDevice.status).toBe(401);
  });

  it("rejects tampering and duplicate delivery before dispatch, including concurrent replay and host restart", async () => {
    const actor = await account("replay-account");
    await actor.client(`${actor.base}/operator/v1/dispatch`, {
      method: "POST",
      headers: actor.headers,
      body: "{}",
    });
    const sent = actor.outerRequests.findLast((r) => r.path === GATEWAY_ENCRYPTED_PATH)!;
    const replay = () => actor.raw(`${actor.base}${sent.path}`, sent.init);
    expect((await Promise.all([replay(), replay()])).map((r) => r.status)).toEqual([401, 401]);
    expect(actor.getDispatched()).toBe(1);
    actor.restart();
    expect((await replay()).status).toBe(401);
    expect((await actor.client(`${actor.base}/v1/devices/self`, { headers: actor.headers })).status).toBe(
      200,
    );
    const mutate = createGatewayEncryptedFetch({
      crypto,
      credential: actor.getCredential,
      fetchImpl: async (input, init) => {
        if (String(input).endsWith(GATEWAY_ENCRYPTED_PATH)) {
          const envelope = JSON.parse(String(init?.body));
          envelope.sealed = (envelope.sealed[0] === "A" ? "B" : "A") + envelope.sealed.slice(1);
          return actor.raw(input, { ...init, body: JSON.stringify(envelope) });
        }
        return actor.raw(input, init);
      },
    });
    await expect(
      mutate(`${actor.base}/operator/v1/dispatch`, { method: "POST", headers: actor.headers, body: "{}" }),
    ).rejects.toThrow();
    expect(actor.getDispatched()).toBe(1);
    actor.restart(true);
    await expect(actor.client(`${actor.base}/v1/devices/self`, { headers: actor.headers })).rejects.toThrow();
  });

  it.each(["truncate", "reorder", "tamper", "replay"])(
    "rejects %s response before releasing an HTTP result",
    async (attack) => {
      const actor = await account(`response-${attack}`);
      const client = createGatewayEncryptedFetch({
        crypto,
        credential: actor.getCredential,
        fetchImpl: async (input, init) => {
          const response = await actor.raw(input, init);
          if (!String(input).endsWith(GATEWAY_ENCRYPTED_PATH)) return response;
          const records = (await response.text()).trimEnd().split("\n");
          if (attack === "truncate") records.pop();
          if (attack === "reorder") [records[0], records[1]] = [records[1]!, records[0]!];
          if (attack === "tamper") {
            const record = JSON.parse(records[1]!);
            record.sealed = "A" + record.sealed.slice(1);
            records[1] = JSON.stringify(record);
          }
          if (attack === "replay") records.splice(1, 0, records[1]!);
          return new Response(records.join("\n") + "\n");
        },
      });
      await expect(
        client(`${actor.base}/operator/v1/dispatch`, { method: "POST", headers: actor.headers, body: "{}" }),
      ).rejects.toThrow();
    },
  );

  it("preserves refresh and live revocation checks; expired tickets cannot bypass identity", async () => {
    const actor = await account("revoked-account");
    const refreshed = await actor.client(`${actor.base}/v1/devices/self/session/refresh`, {
      method: "POST",
      headers: actor.headers,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get("x-clankie-encryption-ticket")).toBeTruthy();
    const revoked = await actor.app.app.request(`/v1/devices/${actor.device.deviceId}/revoke`, {
      method: "POST",
      headers: { authorization: "Bearer owner" },
    });
    expect(revoked.status).toBe(200);
    const response = await actor.client(`${actor.base}/operator/v1/dispatch`, {
      method: "POST",
      headers: actor.headers,
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(actor.getDispatched()).toBe(0);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 8 * 86400_000);
    await expect(actor.client(`${actor.base}/v1/devices/self`, { headers: actor.headers })).rejects.toThrow();
  });
});
