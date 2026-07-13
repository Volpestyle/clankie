import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import { SqliteEventStore } from "@clankie/event-store";
import { SUPERVISE_GRANTS, type DeviceGrantSet } from "@clankie/protocol";
import type { Hono } from "hono";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createControlPlane, type TrustedOperatorIdentity } from "../src/app.ts";

const tempDirs: string[] = [];
let doctrine: Awaited<ReturnType<typeof loadDoctrine>>;
/** Fixed key so device tokens issued before a restart still verify after it. */
const DEVICE_KEY = Uint8Array.from(Buffer.alloc(32, 7));
const OPERATOR = { authorization: "Bearer operator-secret" };
const IOS = { name: "James iPhone", platform: "ios" } as const;

async function loadDoctrine() {
  return compileDoctrine([
    await loadDoctrineFile(resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml")),
  ]);
}

beforeAll(async () => {
  doctrine = await loadDoctrine();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function operator(request: Request): Promise<TrustedOperatorIdentity | undefined> {
  return Promise.resolve(
    request.headers.get("authorization") === "Bearer operator-secret"
      ? { operatorId: "operator-james" }
      : undefined,
  );
}

interface Harness {
  app: Hono;
  advanceMs(ms: number): void;
}

async function makeStore(): Promise<SqliteEventStore> {
  const root = await mkdtemp(join(tmpdir(), "clankie-devices-"));
  tempDirs.push(root);
  return new SqliteEventStore(join(root, "events.db"));
}

async function makeApp(
  store: SqliteEventStore,
  options: { deviceSessionKey?: Uint8Array } = { deviceSessionKey: DEVICE_KEY },
): Promise<Harness> {
  let nowMs = Date.parse("2026-07-13T12:00:00.000Z");
  const app = await createControlPlane({
    doctrine,
    eventStore: store,
    authenticateOperator: operator,
    hostDisplayName: "Test Mac",
    clock: () => new Date(nowMs),
    ...(options.deviceSessionKey === undefined ? {} : { deviceSessionKey: options.deviceSessionKey }),
  });
  return {
    app,
    advanceMs(ms) {
      nowMs += ms;
    },
  };
}

async function mintOffer(app: Hono): Promise<{ offerSecret: string; code: string }> {
  const res = await app.request("/v1/pairing/offer", {
    method: "POST",
    headers: { ...OPERATOR, "content-type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(200);
  const wire = (await res.json()) as { deepLink: string; code: string };
  const offerSecret = new URL(wire.deepLink).searchParams.get("offer");
  expect(offerSecret).toBeTruthy();
  return { offerSecret: offerSecret as string, code: wire.code };
}

async function redeem(app: Hono, body: unknown): Promise<Response> {
  return app.request("/v1/pairing/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function complete(app: Hono, body: unknown): Promise<Response> {
  return app.request("/v1/pairing/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function deviceGet(app: Hono, path: string, token: string): Promise<Response> {
  return app.request(path, { headers: { authorization: `Bearer ${token}` } });
}

async function devicePost(app: Hono, path: string, token: string): Promise<Response> {
  return app.request(path, { method: "POST", headers: { authorization: `Bearer ${token}` } });
}

/** Full offer → redeem → complete, returning the activated device id and token. */
async function pairDevice(app: Hono): Promise<{ deviceId: string; token: string }> {
  const { offerSecret } = await mintOffer(app);
  const redeemed = (await redeem(app, { offerSecret, device: IOS }).then((r) => r.json())) as {
    deviceId: string;
    completionToken: string;
  };
  const completed = (await complete(app, {
    completionToken: redeemed.completionToken,
    acceptedGrants: SUPERVISE_GRANTS,
  }).then((r) => r.json())) as { deviceToken: string };
  return { deviceId: redeemed.deviceId, token: completed.deviceToken };
}

describe("control-plane device pairing surface", () => {
  it("redeems, completes, refreshes, and revokes — old and new tokens both die on revoke", async () => {
    const store = await makeStore();
    const { app } = await makeApp(store);

    const { offerSecret } = await mintOffer(app);
    const redeemRes = await redeem(app, { offerSecret, device: IOS });
    expect(redeemRes.status).toBe(200);
    const redeemed = (await redeemRes.json()) as {
      deviceId: string;
      host: { name: string };
      offeredGrants: DeviceGrantSet;
      completionToken: string;
    };
    expect(redeemed.host.name).toBe("Test Mac");
    expect(redeemed.offeredGrants).toEqual(SUPERVISE_GRANTS);

    const completeRes = await complete(app, {
      completionToken: redeemed.completionToken,
      acceptedGrants: SUPERVISE_GRANTS,
    });
    expect(completeRes.status).toBe(200);
    const completed = (await completeRes.json()) as { deviceToken: string; grants: DeviceGrantSet };
    expect(completed.grants).toEqual(SUPERVISE_GRANTS);
    const token1 = completed.deviceToken;

    expect((await deviceGet(app, "/v1/devices/self", token1)).status).toBe(200);

    const refreshRes = await devicePost(app, "/v1/devices/self/session/refresh", token1);
    expect(refreshRes.status).toBe(200);
    const token2 = ((await refreshRes.json()) as { deviceToken: string }).deviceToken;
    expect(token2).not.toBe(token1);
    // The pre-refresh token stays valid until its own expiry (per-device, not per-token, revocation).
    expect((await deviceGet(app, "/v1/devices/self", token1)).status).toBe(200);

    const revokeRes = await app.request(`/v1/devices/${redeemed.deviceId}/revoke`, {
      method: "POST",
      headers: OPERATOR,
    });
    expect(revokeRes.status).toBe(200);

    for (const token of [token1, token2]) {
      const res = await deviceGet(app, "/v1/devices/self", token);
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("revoked");
      expect((await devicePost(app, "/v1/devices/self/session/refresh", token)).status).toBe(401);
    }
  });

  it("redeems a typed code case-insensitively and dash-agnostically", async () => {
    const { app } = await makeApp(await makeStore());
    const { code } = await mintOffer(app);
    const scrambled = code.toLowerCase().replace(/-/g, "");
    const res = await redeem(app, { code: scrambled, device: { name: "iPad", platform: "ios" } });
    expect(res.status).toBe(200);
  });

  it("carries no grants inside the session token", async () => {
    const { app } = await makeApp(await makeStore());
    const { token } = await pairDevice(app);
    const [payload] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"));
    expect(Object.keys(claims).sort()).toEqual(["deviceId", "expiresAt", "issuedAt", "nonce", "version"]);
  });

  it("refresh reads grants from the projection, so it can never widen", async () => {
    const { app } = await makeApp(await makeStore());
    const { token } = await pairDevice(app);
    const refreshed = (await devicePost(app, "/v1/devices/self/session/refresh", token).then((r) =>
      r.json(),
    )) as { grants: DeviceGrantSet };
    expect(refreshed.grants).toEqual(SUPERVISE_GRANTS);
  });

  describe("offer misuse", () => {
    it("returns consumed on replay and expired on unknown or aged offers", async () => {
      const { app, advanceMs } = await makeApp(await makeStore());
      const { offerSecret } = await mintOffer(app);
      expect((await redeem(app, { offerSecret, device: IOS })).status).toBe(200);

      const replay = await redeem(app, { offerSecret, device: IOS });
      expect(replay.status).toBe(409);
      expect((await replay.json()).error).toBe("consumed");

      const unknown = await redeem(app, { offerSecret: "never-minted-secret", device: IOS });
      expect(unknown.status).toBe(410);
      expect((await unknown.json()).error).toBe("expired");

      const { offerSecret: aged } = await mintOffer(app);
      advanceMs(6 * 60_000);
      const expired = await redeem(app, { offerSecret: aged, device: IOS });
      expect(expired.status).toBe(410);
    });

    it("invalidates outstanding offers across a control-plane restart", async () => {
      const store = await makeStore();
      const { app } = await makeApp(store);
      const { offerSecret } = await mintOffer(app);
      const { app: restarted } = await makeApp(store);
      const res = await redeem(restarted, { offerSecret, device: IOS });
      expect(res.status).toBe(410);
    });
  });

  describe("completion misuse", () => {
    it("rejects a replayed completion token", async () => {
      const { app } = await makeApp(await makeStore());
      const { offerSecret } = await mintOffer(app);
      const { completionToken } = (await redeem(app, { offerSecret, device: IOS }).then((r) => r.json())) as {
        completionToken: string;
      };
      expect((await complete(app, { completionToken, acceptedGrants: SUPERVISE_GRANTS })).status).toBe(200);
      const replay = await complete(app, { completionToken, acceptedGrants: SUPERVISE_GRANTS });
      expect(replay.status).toBe(409);
      expect((await replay.json()).error).toBe("consumed");
    });

    it("expires a completion token after its window", async () => {
      const { app, advanceMs } = await makeApp(await makeStore());
      const { offerSecret } = await mintOffer(app);
      const { completionToken } = (await redeem(app, { offerSecret, device: IOS }).then((r) => r.json())) as {
        completionToken: string;
      };
      advanceMs(11 * 60_000);
      const res = await complete(app, { completionToken, acceptedGrants: SUPERVISE_GRANTS });
      expect(res.status).toBe(410);
    });

    it("denies a device revoked while pending", async () => {
      const { app } = await makeApp(await makeStore());
      const { offerSecret } = await mintOffer(app);
      const { deviceId, completionToken } = (await redeem(app, { offerSecret, device: IOS }).then((r) =>
        r.json(),
      )) as { deviceId: string; completionToken: string };
      expect(
        (await app.request(`/v1/devices/${deviceId}/revoke`, { method: "POST", headers: OPERATOR })).status,
      ).toBe(200);
      const res = await complete(app, { completionToken, acceptedGrants: SUPERVISE_GRANTS });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("revoked");
    });

    it("denies terminalControl without consuming the token, then completes with Supervise", async () => {
      const store = await makeStore();
      const { app } = await makeApp(store);
      const { offerSecret } = await mintOffer(app);
      const { deviceId, completionToken } = (await redeem(app, { offerSecret, device: IOS }).then((r) =>
        r.json(),
      )) as { deviceId: string; completionToken: string };

      const denied = await complete(app, {
        completionToken,
        acceptedGrants: { ...SUPERVISE_GRANTS, terminalControl: true },
      });
      expect(denied.status).toBe(403);
      expect((await denied.json()).error).toBe("terminal_control_not_grantable");

      const ok = await complete(app, { completionToken, acceptedGrants: SUPERVISE_GRANTS });
      expect(ok.status).toBe(200);

      const denials = (await store.readAll())
        .map((stored) => stored.event)
        .filter((event) => event.type === "device.grant.denied" && event.missionId === `device:${deviceId}`);
      expect(denials).toHaveLength(1);
    });
  });

  it("keeps devices isolated: revoking one does not affect another", async () => {
    const { app } = await makeApp(await makeStore());
    const a = await pairDevice(app);
    const b = await pairDevice(app);
    expect(
      (await app.request(`/v1/devices/${a.deviceId}/revoke`, { method: "POST", headers: OPERATOR })).status,
    ).toBe(200);
    expect((await deviceGet(app, "/v1/devices/self", a.token)).status).toBe(401);
    expect((await deviceGet(app, "/v1/devices/self", b.token)).status).toBe(200);
  });

  it("rebuilds identical device state across a restart, revoked devices staying dead", async () => {
    const store = await makeStore();
    const { app } = await makeApp(store);
    const active = await pairDevice(app);
    const revoked = await pairDevice(app);
    await app.request(`/v1/devices/${revoked.deviceId}/revoke`, { method: "POST", headers: OPERATOR });
    const before = await (await app.request("/v1/devices", { headers: OPERATOR })).json();

    const { app: restarted } = await makeApp(store);
    const after = await (await restarted.request("/v1/devices", { headers: OPERATOR })).json();
    expect(after).toEqual(before);
    expect((await deviceGet(restarted, "/v1/devices/self", active.token)).status).toBe(200);
    const revokedRes = await deviceGet(restarted, "/v1/devices/self", revoked.token);
    expect(revokedRes.status).toBe(401);
    expect((await revokedRes.json()).error).toBe("revoked");
  });

  it("omits expired-pending devices from the list and 404s their revoke", async () => {
    const { app, advanceMs } = await makeApp(await makeStore());
    const { offerSecret } = await mintOffer(app);
    const { deviceId } = (await redeem(app, { offerSecret, device: IOS }).then((r) => r.json())) as {
      deviceId: string;
    };
    advanceMs(11 * 60_000);
    expect(await (await app.request("/v1/devices", { headers: OPERATOR })).json()).toEqual([]);
    expect(
      (await app.request(`/v1/devices/${deviceId}/revoke`, { method: "POST", headers: OPERATOR })).status,
    ).toBe(404);
  });

  it("fails device routes closed when no signing key is configured, leaving operator routes up", async () => {
    const store = await makeStore();
    const { app } = await makeApp(store, {});
    expect((await redeem(app, { offerSecret: "x", device: IOS })).status).toBe(503);
    expect((await app.request("/v1/devices/self")).status).toBe(503);
    expect((await app.request("/v1/devices", { headers: OPERATOR })).status).toBe(200);
  });

  it("records no offer secret, code, completion token, or device token in the event log", async () => {
    const store = await makeStore();
    const { app } = await makeApp(store);
    const { offerSecret, code } = await mintOffer(app);
    const redeemed = (await redeem(app, { offerSecret, device: IOS }).then((r) => r.json())) as {
      completionToken: string;
    };
    const completed = (await complete(app, {
      completionToken: redeemed.completionToken,
      acceptedGrants: SUPERVISE_GRANTS,
    }).then((r) => r.json())) as { deviceToken: string };

    const serialized = JSON.stringify((await store.readAll()).map((stored) => stored.event));
    for (const secret of [offerSecret, code, redeemed.completionToken, completed.deviceToken]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("keeps state coherent when revoke races refresh", async () => {
    const store = await makeStore();
    const { app } = await makeApp(store);
    const { deviceId, token } = await pairDevice(app);
    await Promise.all([
      app.request(`/v1/devices/${deviceId}/revoke`, { method: "POST", headers: OPERATOR }),
      devicePost(app, "/v1/devices/self/session/refresh", token),
    ]);
    // Whoever wins the lock, the device ends revoked and stays revoked...
    const res = await deviceGet(app, "/v1/devices/self", token);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("revoked");
    // ...and no refresh event was recorded after the revocation.
    const types = (await store.readAll())
      .map((stored) => stored.event)
      .filter((event) => event.missionId === `device:${deviceId}`)
      .map((event) => event.type);
    const revokedAt = types.indexOf("device.revoked");
    const lastRefreshAt = types.lastIndexOf("device.session.refreshed");
    expect(lastRefreshAt).toBeLessThan(revokedAt);
  });
});
