import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SUPERVISE_GRANTS } from "@clankie/protocol";
import { createClankieApp, type ClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { HostedDeviceSecurity } from "../src/hosted-device-security.ts";
import type { HostedSecurityState } from "../src/hosted-body.ts";
import { ControlPlaneDeviceAuthorizer } from "../../relay/src/device-auth.ts";

const roots: string[] = [],
  apps: ClankieApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "restore-authority-"));
  roots.push(root);
  const eventLogPath = join(root, "events.jsonl");
  const key = new Uint8Array(32).fill(7);
  let reachable = true;
  let state: HostedSecurityState = { gen: 0, rev: [], ak: null, pk: null }; // external fleet fixture, not restored
  const hostedBody = { registerWakeKey: async () => {}, revokeWakeKey: async () => {} };
  const source = {
    async readSecurityState() {
      if (!reachable) throw new Error("fleet unavailable");
      return structuredClone(state);
    },
    async declareAuthKey(kid: string) {
      if (!reachable) throw new Error("fleet unavailable");
      state = { ...state, gen: state.gen + 1, ak: { kid, gen: state.gen + 1 } };
    },
    async revokeDevice(dev: string) {
      if (!reachable) throw new Error("fleet unavailable");
      if (!state.rev.some((r) => r.dev === dev))
        state = {
          ...state,
          gen: state.gen + 1,
          rev: [...state.rev, { dev, at: Date.now(), gen: state.gen + 1 }],
        };
    },
  };
  const boot = async () => {
    const app = await createClankieApp({
      captain: createStubCaptain(),
      eventLogPath,
      deviceSessionKey: key,
      hostedBody,
      hostedDeviceSecurity: new HostedDeviceSecurity(source, join(root, "identity.json")),
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
    });
    apps.push(app);
    return app;
  };
  let current = await boot();
  const json = async (path: string, body: unknown = {}, owner = false) => {
    const response = await current.app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(owner ? { authorization: "Bearer owner" } : {}) },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  const pair = async () => {
    const offer = await json("/v1/pairing/offer", {}, true);
    const redeemed = await json("/v1/pairing/redeem", {
      offerSecret: new URL(offer.deepLink).searchParams.get("offer"),
      device: { name: "Fixture", platform: "ios" },
    });
    const complete = await json("/v1/pairing/complete", {
      completionToken: redeemed.completionToken,
      acceptedGrants: SUPERVISE_GRANTS,
    });
    return { deviceId: redeemed.deviceId as string, token: complete.deviceToken as string };
  };
  const deniedDevice = await pair(),
    validDevice = await pair();
  const authorizer = new ControlPlaneDeviceAuthorizer({
    baseUrl: "http://control",
    fetch: async (input, init) => current.app.request(String(input), init),
  });
  return {
    deniedDevice,
    validDevice,
    authorizer,
    snapshot: () => copyFile(eventLogPath, join(root, "snapshot")),
    revoke: () => json(`/v1/devices/${deniedDevice.deviceId}/revoke`, {}, true),
    async restore() {
      current.close();
      await copyFile(join(root, "snapshot"), eventLogPath);
      current = await boot();
    },
    disconnect() {
      reachable = false;
    },
    reconnect() {
      reachable = true;
    },
    health: () => current.app.request("/health"),
    revokeRaw: () =>
      current.app.request(`/v1/devices/${deniedDevice.deviceId}/revoke`, {
        method: "POST",
        headers: { authorization: "Bearer owner" },
      }),
  };
}

it("revoke after snapshot then restore: restored active device is refused, valid device still works", async () => {
  const f = await fixture();
  await f.snapshot();
  await f.revoke();
  await f.restore();
  expect(await f.authorizer.authorize(f.deniedDevice.token)).toEqual({
    authorized: false,
    denial: "revoked",
  });
  expect((await f.authorizer.authorize(f.validDevice.token)).authorized).toBe(true);
  // The reconciled tombstone is durable, not only an overlay for one process.
  await f.snapshot();
  await f.restore();
  expect(await f.authorizer.authorize(f.deniedDevice.token)).toEqual({
    authorized: false,
    denial: "revoked",
  });
});

it("a restored body with unreachable fleet refuses even a valid bearer", async () => {
  const f = await fixture();
  await f.snapshot();
  f.disconnect();
  await f.restore();
  expect(await f.authorizer.authorize(f.validDevice.token)).toEqual({
    authorized: false,
    denial: "unavailable",
  });
});

it("keeps admission unavailable until a later successful boot reconciliation", async () => {
  const f = await fixture();
  await f.snapshot();
  f.disconnect();
  vi.useFakeTimers();
  await f.restore();
  expect((await f.health()).status).toBe(503);
  expect((await f.authorizer.authorize(f.validDevice.token)).authorized).toBe(false);
  f.reconnect();
  await vi.advanceTimersByTimeAsync(30_000);
  // Real filesystem I/O from the interval is deliberately not replaced by fake timers.
  await vi.waitFor(async () => expect((await f.health()).status).toBe(200));
  expect((await f.authorizer.authorize(f.validDevice.token)).authorized).toBe(true);
});

it("does not acknowledge revocation while fleet is offline; boot exports the pending tombstone", async () => {
  const f = await fixture();
  f.disconnect();
  expect((await f.revokeRaw()).status).toBe(503);
  expect(await f.authorizer.authorize(f.deniedDevice.token)).toEqual({
    authorized: false,
    denial: "revoked",
  });
  await f.snapshot();
  f.reconnect();
  await f.restore();
  expect(await f.authorizer.authorize(f.deniedDevice.token)).toEqual({
    authorized: false,
    denial: "revoked",
  });
  expect((await f.authorizer.authorize(f.validDevice.token)).authorized).toBe(true);
});
