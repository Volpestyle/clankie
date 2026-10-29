import { createECDH, randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { SUPERVISE_GRANTS } from "@clankie/protocol";
import { createClankieApp, type ClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
const apps: ClankieApp[] = [];
afterEach(() => {
  apps.splice(0).forEach((app) => app.close());
});

it("serves neither the wake-key nor the hosted pair-offer route", async () => {
  const clankie = await createClankieApp({
    captain: createStubCaptain(),
    deviceSessionKey: randomBytes(32),
    authenticateOperator: async (req) =>
      req.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
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
  expect((await post("/v1/devices/wake-key", { publicKey: key }, device.deviceToken)).status).toBe(404);
  expect((await post("/v1/hosted/pair-offer")).status).toBe(404);
});
