import type { ModelKeysPort } from "../src/model-keys.ts";
import type { AccountsPort } from "../src/accounts.ts";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUPERVISE_GRANTS, TAKE_CONTROL_GRANTS, type DeviceGrantSet } from "@clankie/protocol";
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
  modelKeys?: ModelKeysPort,
  grants: DeviceGrantSet = SUPERVISE_GRANTS,
  accounts?: AccountsPort,
) {
  const hostId = derivePublicGatewayHostId(accountId, "i".repeat(22));
  const master = randomBytes(32);
  const onAuthenticatedRequest = vi.fn();
  let host = new GatewayEncryptionHost(hostId, master, onAuthenticatedRequest);
  let credential: GatewayEncryptionCredential;
  const base = `http://127.0.0.1/h/${hostId}`;
  const app = await createClankieApp({
    captain: createStubCaptain(),
    ...(modelKeys === undefined ? {} : { modelKeys }),
    ...(accounts === undefined ? {} : { accounts }),
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
    body: JSON.stringify({ completionToken: pending.completionToken, acceptedGrants: grants }),
  });
  expect(complete.status).toBe(200);
  credential!.ticket = complete.headers.get("x-clankie-encryption-ticket")!;
  credential!.key = complete.headers.get("x-clankie-encryption-key")!;
  const device = await complete.json();
  const headers = { authorization: `Bearer ${device.deviceToken}`, "content-type": "application/json" };
  return {
    app,
    onAuthenticatedRequest,
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

        public override async json(): Promise<unknown> {
          return JSON.parse(await this.text()) as unknown;
        }
      },
    );
    const json = '{"name":"Renaming… ⠼"}';
    const bytes = new TextEncoder().encode(json);
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

    expect(new Uint8Array(await response.clone().arrayBuffer())).toEqual(bytes);
    expect(new Uint8Array(await (await response.clone().blob()).arrayBuffer())).toEqual(bytes);
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(json);

    const jsonResponse = await actor.client(`${actor.base}/operator/v1/dispatch`, {
      method: "POST",
      headers: actor.headers,
      body: "{}",
    });
    expect(await jsonResponse.json()).toEqual({ name: "Renaming… ⠼" });

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
            record.sealed = (record.sealed[0] === "A" ? "B" : "A") + record.sealed.slice(1);
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

it("returns a self-hosted 404 through the encrypted wake-key route", async () => {
  const own = await account("wake-account");
  const response = await own.client(`${own.base}/v1/devices/wake-key`, {
    method: "POST",
    headers: own.headers,
    body: JSON.stringify({ publicKey: "A".repeat(87) }),
  });
  expect(response.status).toBe(404);
});

it("passes only work classification across the runtime boundary and excludes revoked sends", async () => {
  const own = await account("work-account");
  expect(own.onAuthenticatedRequest).toHaveBeenCalledTimes(2); // successful pairing
  await own.client(`${own.base}/v1/devices/self`, { headers: own.headers });
  expect(own.onAuthenticatedRequest).toHaveBeenCalledTimes(3);
  expect(own.onAuthenticatedRequest).toHaveBeenLastCalledWith(false);
  const body = JSON.stringify({
    op: "send",
    schemaVersion: 1,
    turn: {
      schemaVersion: 1,
      kind: "message",
      conversationId: "conversation-1",
      surfaceClientId: "phone",
      expectedRevision: 0,
      message: "work",
    },
  });
  await own.client(`${own.base}/operator/v1/dispatch`, { method: "POST", headers: own.headers, body });
  expect(own.onAuthenticatedRequest).toHaveBeenCalledTimes(4);
  expect(own.onAuthenticatedRequest).toHaveBeenLastCalledWith(true);
  expect(
    own.onAuthenticatedRequest.mock.calls.every((args) => args.length === 1 && typeof args[0] === "boolean"),
  ).toBe(true);
  await own.app.app.request(`/v1/devices/${own.device.deviceId}/revoke`, {
    method: "POST",
    headers: { authorization: "Bearer owner" },
  });
  const denied = await own.client(`${own.base}/operator/v1/dispatch`, {
    method: "POST",
    headers: own.headers,
    body,
  });
  expect(denied.status).toBe(401);
  expect(own.onAuthenticatedRequest).toHaveBeenCalledTimes(4);
});

it("carries model keys only in the encrypted envelope and still checks machine authority", async () => {
  const set = vi.fn(async () => ({ ok: true as const }));
  const models: ModelKeysPort = {
    list: async () => ({ model: null, effectiveModel: null, providers: [] }),
    set,
    validate: async () => ({ ok: true }),
    select: async () => ({ ok: true }),
    remove: async () => ({ ok: true }),
  };
  const marker = "MARKER_KEY_encrypted_only_3831";
  for (const grants of [SUPERVISE_GRANTS, TAKE_CONTROL_GRANTS]) {
    const own = await account("model-keys-account", undefined, models, grants);
    const response = await own.client(`${own.base}/v1/model-keys/set`, {
      method: "POST",
      headers: own.headers,
      body: JSON.stringify({ providerId: "openai", apiKey: marker }),
    });
    expect(response.status).toBe(grants.terminalControl ? 200 : 403);
    expect(JSON.stringify(own.outerRequests)).not.toContain(marker);
    expect(
      (
        await own.raw(`${own.base}/v1/model-keys/set`, {
          method: "POST",
          headers: own.headers,
          body: JSON.stringify({ providerId: "openai", apiKey: marker }),
        })
      ).status,
    ).toBe(426);
  }
  expect(set).toHaveBeenCalledExactlyOnceWith("openai", marker);
});

it("carries account-connection codes only in the encrypted envelope and never returns a token", async () => {
  const code = "MARKER_linear_code_encrypted_only_5120";
  const completeLinear = vi.fn<AccountsPort["completeLinear"]>(async (_state, _code, guard) => {
    await guard?.();
    return {
      ok: true as const,
      connection: { provider: "linear" as const, status: "connected" as const, scopes: ["read", "write"] },
    };
  });
  const clientSecret = "MARKER_linear_app_secret_encrypted_only";
  const connectLinearApp = vi.fn<AccountsPort["connectLinearApp"]>(async (_input, guard) =>
    completeLinear.getMockImplementation()!("", "", guard),
  );
  const accounts: AccountsPort = {
    list: async () => ({
      connections: [{ provider: "github", status: "connected", account: "octo-owner", scopes: ["repo"] }],
    }),
    startGithub: async () => ({ ok: false, error: "unconfigured" }),
    connectLinearApp,
    pollGithub: async () => ({ ok: false, error: "unknown_flow" }),
    startLinear: async () => ({ ok: false, error: "unconfigured" }),
    completeLinear,
    disconnect: async () => ({ ok: true, revoked: true }),
  };
  const state = "s".repeat(32);
  for (const grants of [SUPERVISE_GRANTS, TAKE_CONTROL_GRANTS]) {
    const own = await account("accounts-account", undefined, undefined, grants, accounts);
    const response = await own.client(`${own.base}/v1/accounts/linear/complete`, {
      method: "POST",
      headers: own.headers,
      body: JSON.stringify({ state, code }),
    });
    expect(response.status).toBe(grants.terminalControl ? 200 : 403);
    const appResponse = await own.client(`${own.base}/v1/accounts/linear/app`, {
      method: "POST",
      headers: own.headers,
      body: JSON.stringify({ clientId: "application-id", clientSecret }),
    });
    expect(appResponse.status).toBe(grants.terminalControl ? 200 : 403);
    expect(JSON.stringify(own.outerRequests)).not.toContain(clientSecret);
    expect(
      (
        await own.raw(`${own.base}/v1/accounts/linear/app`, {
          method: "POST",
          headers: own.headers,
          body: JSON.stringify({ clientId: "application-id", clientSecret }),
        })
      ).status,
    ).toBe(426);
    const listed = await own.client(`${own.base}/v1/accounts`, { headers: own.headers });
    expect(listed.status).toBe(grants.terminalControl ? 200 : 403);
    expect(JSON.stringify(own.outerRequests)).not.toContain(code);
    expect(JSON.stringify(own.outerRequests)).not.toContain("octo-owner");
    expect(
      (
        await own.raw(`${own.base}/v1/accounts/linear/complete`, {
          method: "POST",
          headers: own.headers,
          body: JSON.stringify({ state, code }),
        })
      ).status,
    ).toBe(426);
  }
  expect(completeLinear).toHaveBeenCalledExactlyOnceWith(state, code, expect.any(Function));
  expect(connectLinearApp).toHaveBeenCalledExactlyOnceWith(
    { clientId: "application-id", clientSecret },
    expect.any(Function),
  );
});
