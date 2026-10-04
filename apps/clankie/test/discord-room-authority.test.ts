import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SUPERVISE_GRANTS } from "@clankie/protocol";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { DiscordRoomObservations } from "../src/discord-room-observations.ts";
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));
it("the hosted bridge keeps owner proof through inner body limits and measures constructed bodies in UTF-8 bytes", async () => {
  const { randomBytes, randomUUID, generateKeyPairSync } = await import("node:crypto");
  const { TAKE_CONTROL_GRANTS, DiscordSettingsSnapshotSchema } = await import("@clankie/protocol");
  const { SettingsStore } = await import("@clankie/settings");
  const { DeviceSessionSigner, mintDeviceSessionClaims } = await import("../src/device-session.ts");
  const { HostedPairing } = await import("../src/hosted-pairing.ts");
  const { HostedBodyClient } = await import("../src/hosted-body.ts");
  const { hostedFixture } = await import("./fixtures/hosted-body.ts");
  const root = mkdtempSync(join(tmpdir(), "hosted-discord-write-"));
  const settings = new SettingsStore(join(root, "settings.json"));
  const key = randomBytes(32);
  const now = Date.now();
  const signer = new DeviceSessionSigner(key);
  const token = signer.issue(
    mintDeviceSessionClaims({ deviceId: "owner", nowEpochSeconds: Math.floor(now / 1000), ttlSeconds: 600 }),
  );
  const eventLogPath = join(root, "events.jsonl");
  const base = {
    occurredAt: new Date(now).toISOString(),
    missionId: "device:owner",
    correlationId: "fixture",
    profileHash: "fixture",
  };
  writeFileSync(
    eventLogPath,
    [
      {
        ...base,
        id: randomUUID(),
        type: "device.pairing.redeemed",
        data: {
          schemaVersion: 1,
          deviceId: "owner",
          offerId: "fixture",
          name: "Fixture",
          platform: "ios",
          offeredGrants: TAKE_CONTROL_GRANTS,
          mintedBy: "hosted-account-operator",
          pendingExpiresAt: new Date(now + 600_000).toISOString(),
        },
      },
      {
        ...base,
        id: randomUUID(),
        type: "device.activated",
        data: {
          schemaVersion: 1,
          deviceId: "owner",
          grants: TAKE_CONTROL_GRANTS,
          sessionExpiresAt: new Date(now + 3600_000).toISOString(),
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
  );
  const hf = hostedFixture();
  const app = await createClankieApp({
    captain: createStubCaptain(),
    settings,
    eventLogPath,
    deviceSessionKey: key,
    roomObservations: new DiscordRoomObservations(join(root, "rooms.json")),
    discordEnvironment: {},
    hostedPairing: new HostedPairing(
      new HostedBodyClient(hf.bootstrap, { clock: () => hf.now }),
      generateKeyPairSync("ed25519").privateKey,
      { clock: () => hf.now },
    ),
  });
  cleanups.push(() => {
    app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const bridge = (method: "GET" | "POST", body?: unknown) =>
    app.app.request("/v1/hosted/operator", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        method,
        path: "/v1/discord/settings",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    });
  const snapshot = DiscordSettingsSnapshotSchema.parse(await (await bridge("GET")).json());
  const saved = await bridge("POST", {
    expectedRevision: snapshot.revision,
    settings: { ...snapshot.settings, guildId: "12345" },
  });
  expect(saved.status).toBe(200);
  expect((await settings.load()).discord.guildId).toBe("12345");
  expect(
    (await bridge("POST", { expectedRevision: snapshot.revision, settings: snapshot.settings })).status,
  ).toBe(409);
  // Fewer than 32K characters, more than 32K UTF-8 bytes: the inner limit must
  // reject it before parsing (400) or writing, despite trusted request branding.
  // Room routes deliberately bound middleware errors to their generic denial.
  expect((await bridge("POST", { padding: "🌱".repeat(9000) })).status).toBe(403);
  expect((await settings.load()).discord.guildId).toBe("12345");
});
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

it("voice health requires the exact registered body and active physical stay, independently of its owning thread", async () => {
  const { randomUUID } = await import("node:crypto");
  const { DiscordPresenceSession } = await import("@clankie/discord-presence-core");
  const { emptySettings } = await import("@clankie/settings");
  const { BodyVoiceStays } = await import("../src/body-voice-stays.ts");
  const { BodyLeaseStore } = await import("../src/body-leases.ts");
  const root = mkdtempSync(join(tmpdir(), "voice-room-evidence-"));
  const store = new DiscordRoomObservations(join(root, "rooms.json"));
  const leases = new BodyLeaseStore(root);
  const voice = new BodyVoiceStays(leases, join(root, "voice.json"));
  const settings = emptySettings();
  settings.discord.voiceEnabled = true;
  const app = await createClankieApp({
    captain: createStubCaptain(),
    roomObservations: store,
    bodyVoiceStays: voice,
    settings: { load: async () => structuredClone(settings) },
    discordEnvironment: {},
    authenticateCaptain: async () => ({ captainId: "voice-body", steerSourceLane: "discord_voice" }),
  });
  cleanups.push(() => {
    app.close();
    leases.close();
    rmSync(root, { recursive: true, force: true });
  });
  const post = (path: string, body: unknown) =>
    app.app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const session = new DiscordPresenceSession({
    sessionId: "body",
    characterId: "clankie",
    credentialRef: "discord_bot",
    transportKind: "bot",
    emit: async (event) => {
      const response = await post("/v1/discord/presence-session-events", event);
      expect(response.status).toBe(200);
      return (await response.json()).session;
    },
  });
  await session.start();
  await session.gatewayReady();
  const stay = {
    stayId: randomUUID(),
    generation: 1,
    target: {
      guildId: "12345",
      channelId: "67890",
      actorId: "11111",
      presenceSessionId: "body",
      transportKind: "bot" as const,
    },
  };
  const claim = await voice.claim(stay, {
    conversationId: "separate-owning-thread",
    current: () => true,
    authorize: async () => true,
  });
  expect(claim.outcome).toBe("acquired");
  if (claim.outcome === "acquired")
    cleanups.unshift(() => {
      voice.finish(stay, claim.incarnation);
    });
  const event = {
    id: "utterance:settled",
    deliveryId: "utterance",
    presenceSessionId: "body",
    transportKind: "bot",
    voiceStayId: stay.stayId,
    guildId: "12345",
    channelId: "67890",
    actorId: "11111",
    outcome: "settled",
  };
  expect((await post("/v1/discord/room-evidence", { ...event, voiceStayId: randomUUID() })).status).toBe(403);
  expect(
    (await post("/v1/discord/room-evidence", { ...event, presenceSessionId: "foreign-body" })).status,
  ).toBe(403);
  expect((await post("/v1/discord/room-evidence", event)).status).toBe(200);
  expect(store.status("room:discord_voice:12345:67890")).toMatchObject({ answered: 1, received: 1 });
  await session.gatewayDisconnected();
  expect((await post("/v1/discord/room-evidence", { ...event, deliveryId: "late" })).status).toBe(403);
  expect(store.status("room:discord_voice:12345:67890").received).toBe(1);
});
