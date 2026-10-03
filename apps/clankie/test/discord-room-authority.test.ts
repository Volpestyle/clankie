import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SUPERVISE_GRANTS } from "@clankie/protocol";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { DiscordRoomObservations } from "../src/discord-room-observations.ts";
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));
it("paired steer guides only its dedicated route; generic captain hints never establish owner authority; revocation expires pending guidance", async () => {
  const root = mkdtempSync(join(tmpdir(), "room-authority-"));
  const store = new DiscordRoomObservations(join(root, "rooms.json"));
  const captain = createStubCaptain();
  const now = new Date().toISOString();
  const room = {
    schemaVersion: 1 as const,
    conversationId: "discord-room",
    scope: { kind: "room" as const, lane: "discord_presence" as const, targetId: "guild:channel" },
    title: "Garden",
    isDefault: false,
    createdAt: now,
    updatedAt: now,
    sessionState: "active" as const,
    revision: 0,
  };
  captain.serveOperatorConversation = async (request) =>
    request.op === "get"
      ? { schemaVersion: 1, op: "get", conversation: room }
      : { schemaVersion: 1, op: "list", conversations: [room] };
  const app = await createClankieApp({
    captain,
    roomObservations: store,
    deviceSessionKey: Uint8Array.from(Buffer.alloc(32, 7)),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
    authenticateCaptain: async () => ({ captainId: "fake", steerSourceLane: "api" }),
  });
  cleanups.push(() => {
    app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const post = (path: string, body: unknown, token?: string) =>
    app.app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  const guidance = { conversationId: room.conversationId, text: "Private context", expectedRevision: 0 };
  expect((await post("/v1/discord/room-guidance", guidance, "captain")).status).toBe(403);
  const offer = (await (await post("/v1/pairing/offer", {}, "owner")).json()) as { deepLink: string };
  const redeemed = (await (
    await post("/v1/pairing/redeem", {
      offerSecret: new URL(offer.deepLink).searchParams.get("offer"),
      device: { name: "Phone", platform: "ios" },
    })
  ).json()) as { deviceId: string; completionToken: string };
  const paired = (await (
    await post("/v1/pairing/complete", {
      completionToken: redeemed.completionToken,
      acceptedGrants: SUPERVISE_GRANTS,
    })
  ).json()) as { deviceToken: string };
  expect((await post("/v1/discord/room-guidance", guidance, paired.deviceToken)).status).toBe(200);
  expect((await post("/v1/discord/settings", {}, paired.deviceToken)).status).toBe(403);
  expect(
    (await post("/v1/hosted/operator", { method: "GET", path: "/v1/discord/settings" }, paired.deviceToken))
      .status,
  ).not.toBe(200);
  await post(`/v1/devices/${redeemed.deviceId}/revoke`, {}, "owner");
  expect(await store.consume(room.conversationId, () => true)).toBeUndefined();
  expect(store.status(room.conversationId).guidance.state).toBe("expired");
});

it("room evidence refuses settings revoked during fresh body authentication", async () => {
  const root = mkdtempSync(join(tmpdir(), "room-settings-race-"));
  const observations = new DiscordRoomObservations(join(root, "rooms.json"));
  const { emptySettings } = await import("@clankie/settings");
  let settings = emptySettings();
  settings.discord = { ...settings.discord, textIngressEnabled: true, ingressGuildIds: ["12345"] };
  let calls = 0;
  const app = await createClankieApp({
    captain: createStubCaptain(),
    roomObservations: observations,
    discordEnvironment: {},
    settings: { load: async () => structuredClone(settings) },
    authenticateCaptain: async () => {
      if (++calls === 2) settings.discord.ingressGuildIds = [];
      return { captainId: "body", steerSourceLane: "discord_text" };
    },
  });
  cleanups.push(() => {
    app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const response = await app.app.request("/v1/discord/room-evidence", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "a:accepted",
      deliveryId: "a",
      presenceSessionId: "body1",
      transportKind: "bot",
      guildId: "12345",
      channelId: "67890",
      actorId: "11111",
      outcome: "accepted",
    }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "room_evidence_settings_changed" });
  expect(observations.list()).toEqual([]);
});
