import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { SUPERVISE_GRANTS } from "@clankie/protocol";
import { SUPPORT_DEVICE_GRANTS } from "@clankie/protocol/support-access";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";
import { composerHttpFixture as fixture, closeComposerFixtures } from "./fixtures/composer-http.ts";
afterEach(closeComposerFixtures);

it("keeps composer transcription local and ineligible through genuine paired-device encryption", async () => {
  const f = await fixture();
  expect(await f.api.status()).toMatchObject({ mode: "local", state: "ineligible" });
  await expect(f.api.begin({ requestId: randomUUID(), audioBytes: 46 })).rejects.toMatchObject({
    status: 403,
  });
  for (const token of ["owner", "captain"])
    expect(
      (
        await fetch(`${f.bodyUrl}/v1/composer/transcription/status`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(401);
});

it("refuses expired, read-only, support and revoked device sessions", async () => {
  const f = await fixture();
  const status = (token: string) =>
    fetch(`${f.bodyUrl}/v1/composer/transcription/status`, { headers: { authorization: `Bearer ${token}` } });
  const expired = new DeviceSessionSigner(f.key).issue(
    mintDeviceSessionClaims({
      deviceId: f.device.deviceId,
      nowEpochSeconds: Math.floor(f.now() / 1000) - 10,
      ttlSeconds: 1,
    }),
  );
  expect((await status(expired)).status).toBe(401);
  const observer = await f.pair({ ...SUPERVISE_GRANTS, chat: false });
  expect((await status(observer.token)).status).toBe(401);
  const support = await f.pair(SUPPORT_DEVICE_GRANTS, "owner", await f.createSupportGrant());
  expect((await status(support.token)).status).toBe(401);
  expect((await status(f.device.token)).status).toBe(200);
  await fetch(`${f.bodyUrl}/v1/devices/${f.device.deviceId}/revoke`, {
    method: "POST",
    headers: { authorization: "Bearer owner" },
  });
  expect((await status(f.device.token)).status).toBe(401);
});
