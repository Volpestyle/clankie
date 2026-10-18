import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceResultSchema,
  TAKE_CONTROL_GRANTS,
  SUPERVISE_GRANTS,
} from "@clankie/protocol";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";
import { createClankieApp } from "../src/app.ts";
import { leadChatFixture } from "./fixtures/lead-chats.ts";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

it("reuses the private roster for an owner device and refuses visitors, guests, support, Discord and revoked devices", async () => {
  const f = await leadChatFixture(false, cleanup);
  const key = randomBytes(32),
    signer = new DeviceSessionSigner(key);
  const now = Math.floor(Date.now() / 1000) * 1000;
  const events = [
    { id: "owner", mintedBy: "custom-owner", grants: TAKE_CONTROL_GRANTS },
    { id: "visitor", mintedBy: "hosted-account", grants: TAKE_CONTROL_GRANTS },
    { id: "guest", mintedBy: "local-operator", grants: SUPERVISE_GRANTS },
    { id: "support", mintedBy: "local-operator", grants: TAKE_CONTROL_GRANTS, supportGrantId: randomUUID() },
  ].flatMap(({ id: deviceId, mintedBy, grants, ...support }) => {
    const base = {
      occurredAt: new Date(now).toISOString(),
      missionId: `device:${deviceId}`,
      correlationId: "fixture",
      profileHash: "fixture",
    };
    return [
      {
        ...base,
        id: randomUUID(),
        type: "device.pairing.redeemed",
        data: {
          schemaVersion: 1,
          deviceId,
          offerId: deviceId,
          name: deviceId,
          platform: "ios",
          offeredGrants: grants,
          mintedBy,
          ...support,
          pendingExpiresAt: new Date(now + 600_000).toISOString(),
        },
      },
      {
        ...base,
        id: randomUUID(),
        type: "device.activated",
        data: {
          schemaVersion: 1,
          deviceId,
          grants,
          sessionExpiresAt: new Date(now + 600_000).toISOString(),
        },
      },
    ];
  });
  const eventPath = join(f.root, "device-events.jsonl");
  await writeFile(eventPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const service = await createClankieApp({
    captain: f.captain,
    eventLogPath: eventPath,
    deviceSessionKey: key,
    authenticateOperator: async (req) =>
      req.headers.get("authorization") === "Bearer operator" ? { operatorId: "owner" } : undefined,
    authenticateCaptain: async (req) =>
      req.headers.get("authorization") === "Bearer discord"
        ? { captainId: "discord", steerSourceLane: "discord_voice" }
        : undefined,
  });
  cleanup.push(async () => service.close());
  const token = (id: string) =>
    signer.issue(mintDeviceSessionClaims({ deviceId: id, nowEpochSeconds: now / 1000, ttlSeconds: 600 }));
  const read = (bearer: string) =>
    service.app.request(OPERATOR_CONVERSATION_DISPATCH_PATH, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "lead_chats", schemaVersion: 1 }),
    });
  const owned = await read(token("owner"));
  expect(owned.status).toBe(200);
  const result = OperatorConversationServiceResultSchema.parse(await owned.json());
  expect(result).toEqual({
    op: "lead_chats",
    schemaVersion: 1,
    result: { outcome: "ready", chats: await f.captain.leadChats!() },
  });
  for (const bearer of [
    token("visitor"),
    token("guest"),
    token("support"),
    "discord",
    "operator",
    "unknown",
  ]) {
    const response = await read(bearer);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "owner_device_required" });
  }
  // VUH-2448: the fleet count is owner-only, including its retire and undo routes.
  const fleetRead = (bearer: string) =>
    service.app.request("/v1/fleet/roster", { headers: { authorization: `Bearer ${bearer}` } });
  expect((await fleetRead(token("owner"))).status).toBe(200);
  expect((await fleetRead("operator")).status).toBe(200);
  for (const bearer of [token("visitor"), token("guest"), token("support"), "discord", "unknown"]) {
    expect((await fleetRead(bearer)).status).toBe(403);
    for (const action of ["retire", "undo"])
      expect(
        (
          await service.app.request(`/v1/fleet/roster/${action}`, {
            method: "POST",
            headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(403);
  }
  await service.app.request("/v1/devices/owner/revoke", {
    method: "POST",
    headers: { authorization: "Bearer operator" },
  });
  expect((await read(token("owner"))).status).toBe(403);
  expect((await fleetRead(token("owner"))).status).toBe(403);
});
