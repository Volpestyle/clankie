import { DiscordStreamWatchProjection } from "../src/stream-watch-observation.ts";
import { DISCORD_STREAM_WATCH_PATH } from "@clankie/protocol";
import { DiscordTurnReceipts } from "../src/captain/discord-turn-receipts.ts";
import type { CaptainPort } from "../src/captain/port.ts";
import { BodyVoiceStays } from "../src/body-voice-stays.ts";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordPresenceSession } from "@clankie/discord-presence-core";
import type { DiscordPresenceWrite } from "@clankie/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { personaRoutes } from "../src/persona-extension.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { BodyLeaseStore } from "../src/body-leases.ts";
import { BodyLeaseRouter } from "../src/body-lease-router.ts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

async function fixture(overrides: Partial<CaptainPort> = {}) {
  const root = mkdtempSync(join(tmpdir(), "clankie-mouth-routes-"));
  const store = new BodyLeaseStore(root);
  let beforeEffect = async () => {};
  const effect = vi.fn();
  const receipts = new DiscordTurnReceipts(join(root, "receipts.json"));
  const router = new BodyLeaseRouter(store);
  const app = await createClankieApp({
    extensionRoutes: [personaRoutes({ receipts })],
    captain: createStubCaptain({
      ...overrides,
      submitDiscordTurn: async () => ({
        state: "settled",
        captainSessionId: "fixture",
        turnId: "turn",
        response: "hello",
      }),
    }),
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer fixture"
        ? { captainId: "body", steerSourceLane: "discord_text" }
        : undefined,
    bodyVoiceStays: new BodyVoiceStays(store, join(root, "voice.json")),
    bodyLeases: { store, router, confirmStopped: async () => false },
    discordPresenceRuntime: {
      execute: async (write, _session, guard) => {
        await beforeEffect();
        await guard?.();
        effect();
        return {
          id: write.idempotencyKey,
          action: write.action,
          transportKind: "bot",
          channelId: "room",
          messageId: "reply",
        };
      },
    },
  });
  cleanups.push(async () => {
    await app.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.app.request(path, {
      method: "POST",
      headers: { authorization: "Bearer fixture", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const session = new DiscordPresenceSession({
    sessionId: "body-session",
    characterId: "clankie",
    credentialRef: "discord_bot",
    transportKind: "bot",
    emit: async (event) => {
      const response = await post("/v1/discord/presence-session-events", event);
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()).session;
    },
  });
  await session.start();
  await session.gatewayReady();
  const identity = {
    presenceSessionId: "discord:dm:room",
    correlationId: "source",
    profileHash: "unversioned",
    characterId: "clankie",
    credentialRef: "discord_bot",
    transportKind: "bot" as const,
  };
  expect(
    (
      await post("/v1/captain/channel-turns", {
        schemaVersion: 1,
        deliveryId: "source",
        identity,
        trigger: {
          kind: "dm",
          id: "source",
          channelId: "room",
          messageId: "source",
          actorId: "actor",
          body: "hello",
          attachments: [],
        },
        contextMessages: [],
      })
    ).status,
  ).toBe(200);
  const write: DiscordPresenceWrite = {
    schemaVersion: 1,
    idempotencyKey: "source:reply",
    sourceDeliveryId: "source",
    identity,
    action: "discord.presence.reply",
    payload: { kind: "reply", channelId: "room", messageId: "source", content: "hello" },
  };
  const send = (input = write) =>
    post("/v1/discord/presence-actions", input, {
      "x-clankie-discord-presence-session": session.record.sessionId,
      "x-clankie-discord-presence-phase": session.record.phase,
      "x-clankie-discord-presence-revision": String(session.record.revision),
    });
  return {
    app,
    receipts,
    router,
    post,
    store,
    effect,
    send,
    write,
    session,
    before: (callback: () => Promise<void>) => {
      beforeEffect = callback;
    },
  };
}

it("rejects a forged source and returns the exact other mouth owner without sending", async () => {
  const { store, send, write, effect } = await fixture();
  expect(await (await send({ ...write, sourceDeliveryId: "unknown" })).json()).toEqual({
    outcome: "rejected",
    reason: "identity_required",
  });
  store.acquire("discord_mouth", "other-thread", 1000);
  expect(await (await send()).json()).toMatchObject({
    outcome: "busy",
    lease: { conversationId: "other-thread" },
  });
  expect(effect).not.toHaveBeenCalled();
});

it("rechecks gateway binding at final transport effect and retains uncertainty", async () => {
  const { store, effect, send, session, before } = await fixture();
  before(() => session.gatewayDisconnected().then(() => {}));
  const response = await send();
  expect(response.status).toBe(409);
  expect(effect).not.toHaveBeenCalled();
  expect(store.status("discord_mouth")?.state).toBe("recovery_required");
});

it("persists confirmed delivery before release and deduplicates the original write", async () => {
  const { store, effect, send } = await fixture();
  expect((await send()).status).toBe(200);
  expect((await send()).status).toBe(200);
  expect(effect).toHaveBeenCalledTimes(1);
  expect(store.status("discord_mouth")).toBeUndefined();
});

it.each(["reply", "join_thread"] as const)("rejects %s directed outside the source room", async (kind) => {
  const { send, write, effect } = await fixture();
  const foreign: DiscordPresenceWrite =
    kind === "reply"
      ? { ...write, payload: { kind, channelId: "foreign", messageId: "source", content: "hello" } }
      : { ...write, action: "discord.presence.join_thread", payload: { kind, channelId: "foreign-thread" } };
  expect(await (await send(foreign)).json()).toEqual({ outcome: "rejected", reason: "identity_required" });
  expect(effect).not.toHaveBeenCalled();
});

it("voice RPC binds the registered physical session and exact stay generation", async () => {
  const { post, session } = await fixture();
  const stay = {
    stayId: randomUUID(),
    generation: 1,
    target: {
      guildId: "guild",
      channelId: "room",
      actorId: "actor",
      presenceSessionId: session.record.sessionId,
      transportKind: "bot",
    },
  };
  expect(
    (
      await post("/v1/discord/voice-lease", {
        action: "claim",
        stay: { ...stay, target: { ...stay.target, presenceSessionId: "foreign" } },
      })
    ).status,
  ).toBe(409);
  const claim = await (await post("/v1/discord/voice-lease", { action: "claim", stay })).json();
  expect(claim).toMatchObject({
    outcome: "acquired",
    lease: { conversationId: "room:discord_voice:guild:room" },
  });
  expect(
    (
      await post("/v1/discord/voice-lease", {
        action: "heartbeat",
        stay: { ...stay, generation: 2 },
        incarnation: claim.incarnation,
      })
    ).status,
  ).toBe(409);
  expect(
    (await post("/v1/discord/voice-lease", { action: "finish", stay, incarnation: claim.incarnation }))
      .status,
  ).toBe(200);
});

it("rechecks actual presence after suspended captain grant validation before queue wake", async () => {
  vi.useFakeTimers();
  let release!: (allowed: boolean) => void;
  const validated = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  let resume!: (allowed: boolean) => void;
  const wake = vi.fn(async () => true);
  const f = await fixture({
    validateConversationOwner: async () => {
      release(true);
      return new Promise<boolean>((resolve) => {
        resume = resolve;
      });
    },
    wakeConversation: wake,
  });
  try {
    const origin = f.receipts.get("discord:source")!.origin!;
    const route = {
      owner: {
        conversationId: "owner",
        discord: {
          baseSessionKey: origin.baseSessionKey!,
          targetId: "dm:room",
          actorId: origin.actorId,
          channelId: origin.channelId,
          messageId: "source",
          transportKind: origin.transportKind,
        },
      },
      mode: "social" as const,
    };
    const claim = f.store.acquire("play", "owner", 10000, route);
    if (claim.outcome !== "acquired") throw new Error("claim");
    await f.router.request(
      { conversationId: "owner", route, current: () => true, authorize: async () => true },
      { resource: "play", kind: "queue", text: "next", ttlMs: 10000 },
    );
    f.store.release(claim.lease);
    await vi.advanceTimersByTimeAsync(1000);
    await validated;
    await f.session.gatewayDisconnected();
    resume(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(wake).not.toHaveBeenCalled();
  } finally {
    f.app.stopBodyRequests();
    vi.useRealTimers();
  }
});

it("preserves persona state across an off start without restoring live authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "clankie-persona-replay-"));
  const path = join(root, "events.jsonl");
  const boot = (enabled: boolean) =>
    createClankieApp({
      captain: createStubCaptain(),
      eventLogPath: path,
      discordTurnReceiptPath: join(root, "receipts.json"),
      extensionRoutes: enabled ? [personaRoutes()] : [],
      authenticateCaptain: async () => ({ captainId: "body", steerSourceLane: "discord_text" }),
      authenticateOperator: async () => ({ operatorId: "owner" }),
      discordPresenceRuntime: {
        execute: async () => {
          throw new Error("must_not_execute");
        },
      },
    });
  let service = await boot(true);
  cleanups.push(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
    service.app.request(route, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const session = new DiscordPresenceSession({
    sessionId: "replayed-session",
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
  await session.voiceStateChanged("guild", true, { channelId: "room", occupants: [] });
  await session.voiceStateChanged("guild", false);
  const optInResponse = await post("/v1/discord/user-session/opt-in", {
    schemaVersion: 1,
    characterId: "clankie",
    acknowledgement: "fixture acceptance",
    guildIds: ["guild"],
    channelIds: ["room"],
    dmPolicy: "deny",
  });
  expect(optInResponse.status).toBe(201);
  const optIn = await optInResponse.json();
  const history = service.voiceHistory(32);
  expect(history).toHaveLength(1);
  const saved = readFileSync(path, "utf8");
  await service.close();

  service = await boot(false);
  expect((await service.app.request("/health")).status).toBe(200);
  expect(service.presenceSessions()).toEqual([]);
  expect(service.voiceHistory(32)).toEqual([]);
  expect((await service.app.request("/v1/discord/presence-sessions")).status).toBe(404);
  expect(readFileSync(path, "utf8")).toBe(saved);
  await service.close();

  service = await boot(true);
  expect(service.presenceSessions()).toEqual([session.record]);
  expect(service.voiceHistory(32)).toEqual(history);
  expect(await (await service.app.request("/v1/discord/user-session/opt-in")).json()).toEqual(optIn);
  const response = await post(
    "/v1/discord/presence-actions",
    {
      schemaVersion: 1,
      idempotencyKey: "restart:reply",
      action: "discord.presence.reply",
      identity: {
        presenceSessionId: "discord:dm:room",
        correlationId: "restart",
        profileHash: "unversioned",
        characterId: "clankie",
        credentialRef: "discord_bot",
        transportKind: "bot",
      },
      payload: { kind: "reply", channelId: "room", messageId: "source", content: "hello" },
    },
    {
      "x-clankie-discord-presence-session": session.record.sessionId,
      "x-clankie-discord-presence-phase": session.record.phase,
      "x-clankie-discord-presence-revision": String(session.record.revision),
    },
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: "discord_presence_live_claim_stale" });
});

it("accepts stream reports through World's port and refuses them when World is absent", async () => {
  for (const enabled of [false, true]) {
    const service = await createClankieApp({
      captain: createStubCaptain(),
      extensionRoutes: [personaRoutes()],
      authenticateCaptain: async () => ({ captainId: "body", steerSourceLane: "discord_text" }),
      ...(enabled ? { streamWatch: new DiscordStreamWatchProjection() } : {}),
    });
    try {
      const report = {
        schemaVersion: 1,
        source: "bot",
        streams: [
          {
            schemaVersion: 1,
            streamKey: "stream",
            kind: "guild",
            guildId: "guild",
            channelId: "room",
            userId: "actor",
            watching: true,
            hasFrame: false,
            updatedAt: new Date().toISOString(),
          },
        ],
      };
      const response = await service.app.request(DISCORD_STREAM_WATCH_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(report),
      });
      expect(response.status).toBe(enabled ? 204 : 503);
      expect(service.streamWatch().streams).toEqual(enabled ? report.streams : []);
    } finally {
      await service.close();
    }
  }
});
