import { readFileSync } from "node:fs";
import { DeviceSelfResponseSchema, PairingOfferWireSchema, SUPERVISE_GRANTS } from "@clankie/protocol";
import { expect, it } from "vitest";
import { createQaService } from "./fixtures/qa-service.ts";

it("serves health and enforces operator authority over real HTTP before and after restart", async () => {
  const host = await createQaService();
  try {
    for (let boot = 0; boot < 2; boot++) {
      const health = await fetch(`${host.baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, service: "clankie" });
      expect(
        (
          await fetch(`${host.baseUrl}/v1/pairing/offer`, {
            method: "POST",
            signal: AbortSignal.timeout(5_000),
          })
        ).status,
      ).toBe(401);
      const offer = await host.operator("/v1/pairing/offer");
      expect(offer.status).toBe(200);
      expect(await offer.json()).toMatchObject({
        code: expect.any(String),
        deepLink: expect.stringContaining("clankie://"),
      });
      if (boot === 0) await host.restart();
    }
  } finally {
    await host.close();
  }
});

it("keeps pairing codes operator-only after a device completes normal pairing", async () => {
  const host = await createQaService();
  const post = (path: string, body: unknown, bearer?: string) =>
    fetch(`${host.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
  try {
    const offerResponse = await host.operator("/v1/pairing/offer");
    expect(offerResponse.status).toBe(200);
    const offer = PairingOfferWireSchema.parse(await offerResponse.json());
    expect(offer.localCode).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/u);
    expect(offer.localCode).toBe(offer.code);
    const redeemedResponse = await post("/v1/pairing/redeem", {
      code: offer.localCode,
      device: { name: "Test paired Mac", platform: "macos" },
    });
    expect(redeemedResponse.status).toBe(200);
    const redeemed = await redeemedResponse.json();
    expect(redeemed.deviceToken).toBeUndefined();
    expect(redeemed.code).toBeUndefined();
    expect(redeemed.localCode).toBeUndefined();
    expect(JSON.stringify(redeemed)).not.toContain(offer.localCode!);
    const completedResponse = await post("/v1/pairing/complete", {
      completionToken: redeemed.completionToken,
      acceptedGrants: SUPERVISE_GRANTS,
    });
    expect(completedResponse.status).toBe(200);
    const completed = await completedResponse.json();
    expect(completed.code).toBeUndefined();
    expect(completed.localCode).toBeUndefined();
    expect(JSON.stringify(completed)).not.toContain(offer.localCode!);
    const selfResponse = await fetch(`${host.baseUrl}/v1/devices/self`, {
      headers: { authorization: `Bearer ${completed.deviceToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    expect(selfResponse.status).toBe(200);
    expect(DeviceSelfResponseSchema.parse(await selfResponse.json()).deviceId).toBe(redeemed.deviceId);
    const eventsBeforeRefusals = readFileSync(host.eventLogPath, "utf8");
    for (const bearer of [undefined, "wrong-secret", completed.deviceToken]) {
      const refused = await post("/v1/pairing/offer", {}, bearer);
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual({ error: "operator_authentication_required" });
      expect(readFileSync(host.eventLogPath, "utf8")).toBe(eventsBeforeRefusals);
    }
  } finally {
    await host.close();
  }
});
