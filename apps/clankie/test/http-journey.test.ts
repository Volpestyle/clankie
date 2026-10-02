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
