import { createECDH, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUPERVISE_GRANTS } from "@clankie/protocol";
import { createClankieApp, type ClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
const apps: ClankieApp[] = [];
afterEach(() => {
  apps.splice(0).forEach((app) => app.close());
});

describe("hosted wake key", () => {
  async function setup(hosted = true) {
    const registerWakeKey = vi.fn(async () => {}),
      revokeWakeKey = vi.fn(async () => {});
    const clankie = await createClankieApp({
      captain: createStubCaptain(),
      deviceSessionKey: randomBytes(32),
      authenticateOperator: async (req) =>
        req.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
      ...(hosted ? { hostedBody: { registerWakeKey, revokeWakeKey } } : {}),
    });
    apps.push(clankie);
    const post = (path: string, body: unknown = {}, token = "owner") =>
      clankie.app.request(path, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    const offer = await (await post("/v1/pairing/offer")).json();
    const redeemed = await (
      await post("/v1/pairing/redeem", {
        offerSecret: new URL(offer.deepLink).searchParams.get("offer"),
        device: { name: "Phone", platform: "ios" },
      })
    ).json();
    const device = await (
      await post("/v1/pairing/complete", {
        completionToken: redeemed.completionToken,
        acceptedGrants: SUPERVISE_GRANTS,
      })
    ).json();
    const key = createECDH("prime256v1").generateKeys().toString("base64url");
    return { post, device, key, registerWakeKey, revokeWakeKey };
  }
  it("requires a live device, validates the body and revokes its fleet key", async () => {
    const { post, device, key, registerWakeKey, revokeWakeKey } = await setup();
    expect((await post("/v1/devices/wake-key", { publicKey: key })).status).toBe(401);
    expect((await post("/v1/devices/wake-key", { publicKey: "bad" }, device.deviceToken)).status).toBe(400);
    expect(
      (await post("/v1/devices/wake-key", { publicKey: key, deviceId: "other-device" }, device.deviceToken))
        .status,
    ).toBe(400);
    expect(await (await post("/v1/devices/wake-key", { publicKey: key }, device.deviceToken)).json()).toEqual(
      { deviceId: device.deviceId },
    );
    expect(registerWakeKey).toHaveBeenCalledWith(device.deviceId, key);
    expect((await post(`/v1/devices/${device.deviceId}/revoke`)).status).toBe(200);
    expect(revokeWakeKey).toHaveBeenCalledWith(device.deviceId);
    expect((await post("/v1/devices/wake-key", { publicKey: key }, device.deviceToken)).status).toBe(401);
  });
  it("keeps local revocation even when fleet cleanup fails, and retries", async () => {
    const { post, device, key, revokeWakeKey } = await setup();
    revokeWakeKey.mockRejectedValueOnce(new Error("offline"));
    expect((await post(`/v1/devices/${device.deviceId}/revoke`)).status).toBe(503);
    expect((await post("/v1/devices/wake-key", { publicKey: key }, device.deviceToken)).status).toBe(401);
    expect((await post(`/v1/devices/${device.deviceId}/revoke`)).status).toBe(200);
    expect(revokeWakeKey).toHaveBeenCalledTimes(2);
  });
  it("leaves both routes absent for self-hosted bodies", async () => {
    const { post, device, key, registerWakeKey } = await setup(false);
    expect((await post("/v1/devices/wake-key", { publicKey: key }, device.deviceToken)).status).toBe(404);
    expect((await post("/v1/hosted/pair-offer")).status).toBe(404);
    expect(registerWakeKey).not.toHaveBeenCalled();
  });
});
