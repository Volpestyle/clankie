import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceResultSchema,
  SUPERVISE_GRANTS,
  type DiscordPresenceChannelTurnRequest,
  type OperatorConversationServiceRequest,
} from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { afterEach, expect, it } from "vitest";
import { createBearerAuthenticator, createClankieApp } from "../src/app.ts";
import { createCaptain } from "../src/captain/captain.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import { ConversationStore, type ConversationTurnContext } from "../src/captain/conversations.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { RuntimeProvider } from "../src/runtime-provider.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Real app, captain, native channel, HTTP and durable stores; no model calls.
// Unconnected capabilities fail if this fixture ever falls through to Pi.
async function fixture(provider?: RuntimeProvider) {
  const root = await mkdtemp(join(tmpdir(), "clankie-runtime-provider-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "state");
  await mkdir(state);
  const roomId = new ConversationStore(join(state, "conversations"), async () => {}).roomConversation(
    "discord_presence",
    "12345:67890",
  );
  const unavailable = (): never => {
    throw new Error("This native-channel fixture has no model or external capabilities");
  };
  const deps: CaptainDeps = {
    herdrAvailable: () => false,
    mcp: { catalog: unavailable, call: unavailable },
    email: { list: unavailable, read: unavailable, search: unavailable, send: unavailable },
    browser: { catalog: unavailable, call: unavailable },
    media: { generateImage: unavailable, generateVideo: unavailable, finishedRenders: async () => [] },
    embodiment: {
      submitIntent: unavailable,
      getSession: unavailable,
      getLiveSession: unavailable,
    },
    activity: { current: unavailable },
    presence: {
      listSessions: unavailable,
      listVoiceHistory: unavailable,
      listRecentVoiceSpeech: unavailable,
    },
    memory: {
      writeMemory: unavailable,
      recallMemoryCard: unavailable,
      searchMemory: unavailable,
      editMemory: unavailable,
      forgetMemory: unavailable,
    },
  };
  const captain = createCaptain(deps, {
    repoRoot: root,
    stateDir: state,
    workingDirectory: root,
    settings: new SettingsStore(join(state, "settings.json")),
    ...(provider === undefined ? {} : { runtimeProvider: provider }),
  });
  cleanups.push(() => captain.close());
  const ownerCaptain = createBearerAuthenticator("fixture-owner", {
    captainId: "fixture-captain",
    steerSourceLane: "api" as const,
  });
  const contextCaptain = createBearerAuthenticator("fixture-context", {
    captainId: "fixture-context",
    steerSourceLane: "api" as const,
  });
  const service = await createClankieApp({
    captain,
    deviceSessionKey: randomBytes(32),
    eventLogPath: join(root, "events.jsonl"),
    authenticateOperator: createBearerAuthenticator("fixture-owner", { operatorId: "owner" }),
    authenticateCaptain: async (request) => (await ownerCaptain(request)) ?? contextCaptain(request),
    ...(provider === undefined ? {} : { runtimeProvider: provider }),
  });
  const server = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanups.push(async () => {
    service.close();
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture port");
  const host = `http://127.0.0.1:${address.port}`;
  const request = (path: string, token?: string, body?: unknown) =>
    fetch(`${host}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000),
    });
  const command = async (body: OperatorConversationServiceRequest, token = "fixture-owner") => {
    const response = await request(OPERATOR_CONVERSATION_DISPATCH_PATH, token, body);
    expect(response.status).toBe(200);
    return OperatorConversationServiceResultSchema.parse(await response.json());
  };
  const attach = async (id: string) => {
    expect(await captain.pollSeatEvents(0, undefined, id)).toEqual([]);
    expect(
      captain.syncSeatTranscript(id, { sessionId: `native-${id}`, entries: [], activity: "waiting" }),
    ).toBe(true);
  };
  await attach("global-default");
  await attach(roomId);
  const journal = new ConversationJournal(join(state, "conversations"));
  return { captain, roomId, command, request, journal, attach };
}

it("the default public app has no quota routes and native captain turns still complete", async () => {
  const f = await fixture();
  for (const path of ["/v1/runtime-fixture/quota", "/v1/hosted/credits"])
    expect((await f.request(path, "fixture-owner")).status).toBe(404);
  const polled = f.captain.pollSeatEvents(5_000, undefined, "global-default");
  const current = await f.command({ schemaVersion: 1, op: "get", conversationId: "global-default" });
  if (current.op !== "get" || !current.conversation) throw new Error("Missing default conversation");
  const sending = f.command({
    schemaVersion: 1,
    op: "send",
    turn: {
      schemaVersion: 1,
      kind: "message",
      conversationId: "global-default",
      surfaceClientId: "fixture",
      expectedRevision: current.conversation.revision,
      message: "Native request without hosted policy",
      delivery: "queue",
    },
  });
  const [event] = await polled;
  expect(event?.content).toContain("Native request without hosted policy");
  expect(event).toMatchObject({
    kind: "turn",
    ownerOrigin: { surfaceClientId: "fixture", principal: { kind: "operator", id: "owner" } },
  });
  expect(await f.captain.acknowledgeSeatEvent(event!.id, "global-default")).toBe(true);
  expect((await sending).op).toBe("send");
  expect(await f.captain.replySeatEvent(event!.id, "Separate tool answer", "global-default")).toBe(false);
  expect(
    f.captain.syncSeatTranscript("global-default", {
      sessionId: "native-global-default",
      entries: [{ type: "message", id: "native-answer", role: "agent", text: "Native answer" }],
      activity: "waiting",
    }),
  ).toBe(true);
  await expect
    .poll(() => f.journal.read("global-default"))
    .toContainEqual(expect.objectContaining({ type: "turn", phase: "completed" }));
  expect(
    f.journal.read("global-default").filter((entry) => entry.type === "message" && entry.role === "captain"),
  ).toMatchObject([{ text: "Native answer" }]);
});

it("injected quota routes keep paired-device authorization and heartbeat tracks native escalation lifetime", async () => {
  let quotaReads = 0;
  const starts: ConversationTurnContext["origin"][] = [];
  let finishes = 0;
  const f = await fixture({
    quota: {
      routes(authorize) {
        return new Hono().get("/v1/runtime-fixture/quota", async (context) => {
          const admitted = await authorize(context.req.raw);
          if (admitted !== true)
            return context.json({ error: admitted }, admitted === "forbidden" ? 403 : 401);
          quotaReads++;
          return context.json({ remaining: 7 });
        });
      },
    },
    heartbeat: {
      begin(origin) {
        starts.push(origin);
        return () => {
          finishes++;
        };
      },
      interactive() {},
      authenticatedWork() {},
      activitySharing() {},
      start() {},
      close() {},
    },
  });
  expect((await f.request("/v1/runtime-fixture/quota")).status).toBe(401);
  expect(quotaReads).toBe(0);
  expect(await (await f.request("/v1/runtime-fixture/quota", "fixture-owner")).json()).toEqual({
    remaining: 7,
  });
  const offer = await (await f.request("/v1/pairing/offer", "fixture-owner", {})).json();
  const pending = await (
    await f.request("/v1/pairing/redeem", undefined, {
      offerSecret: new URL(offer.deepLink).searchParams.get("offer"),
      device: { name: "Fixture phone", platform: "ios" },
    })
  ).json();
  const paired = await (
    await f.request("/v1/pairing/complete", undefined, {
      completionToken: pending.completionToken,
      acceptedGrants: SUPERVISE_GRANTS,
    })
  ).json();
  expect((await f.request("/v1/runtime-fixture/quota", paired.deviceToken)).status).toBe(200);
  expect((await f.request(`/v1/devices/${pending.deviceId}/revoke`, "fixture-owner", {})).status).toBe(200);
  expect((await f.request("/v1/runtime-fixture/quota", paired.deviceToken)).status).toBe(401);
  expect(quotaReads).toBe(2);

  for (const unprompted of [false, true]) {
    const deliveryId = `fixture-${unprompted}`;
    const request: DiscordPresenceChannelTurnRequest = {
      schemaVersion: 1,
      deliveryId,
      identity: {
        presenceSessionId: "fixture-body",
        correlationId: deliveryId,
        profileHash: "fixture-profile",
        characterId: "clankie",
        credentialRef: "fixture",
        transportKind: "bot",
      },
      trigger: {
        kind: "message",
        id: deliveryId,
        guildId: "12345",
        channelId: "67890",
        actorId: "11111",
        body: "Native room request",
        attachments: [],
        ...(unprompted ? { unprompted: true } : {}),
      },
      contextMessages: [],
    };
    // No native parent is proved and no model is connected. Failure still closes the activity hook.
    expect(await f.captain.submitDiscordTurn(request)).toMatchObject({
      state: "failed",
      code: "captain_session_failed",
    });
    expect(await f.captain.pollSeatEvents(0, undefined, f.roomId)).toEqual([]);
    expect(finishes).toBe(unprompted ? 2 : 1);
  }
  expect(starts).toEqual([undefined, "wake"]);
  expect(finishes).toBe(2);

  for (const completion of ["reply", "cancel"] as const) {
    const before = finishes;
    const polled = f.captain.pollSeatEvents(5_000, undefined, "global-default");
    const current = await f.command({ schemaVersion: 1, op: "get", conversationId: "global-default" });
    if (current.op !== "get" || !current.conversation) throw new Error("Missing default conversation");
    const message = `Native operator turn: ${completion}`;
    const sending = f.command(
      {
        schemaVersion: 1,
        op: "send",
        turn: {
          schemaVersion: 1,
          kind: "message",
          conversationId: "global-default",
          surfaceClientId: "fixture",
          expectedRevision: current.conversation.revision,
          message,
          delivery: "queue",
        },
      },
      "fixture-context",
    );
    const [event] = await polled;
    expect(event?.content).toContain(message);
    expect(event).toMatchObject({ kind: "escalation" });
    expect(await f.captain.acknowledgeSeatEvent(event!.id, "global-default")).toBe(true);
    expect((await sending).op).toBe("send");
    expect(finishes).toBe(before);
    if (completion === "reply") {
      expect(await f.captain.replySeatEvent(event!.id, "Native operator answer", "global-default")).toBe(
        true,
      );
    } else {
      const accepted = f.journal
        .read("global-default")
        .findLast((event) => event.type === "turn" && event.phase === "accepted");
      if (accepted?.type !== "turn") throw new Error("Missing accepted turn");
      expect(
        await f.command({
          schemaVersion: 1,
          op: "cancel",
          conversationId: "global-default",
          runId: accepted.runId,
        }),
      ).toMatchObject({ op: "cancel", cancelled: true });
    }
    await expect.poll(() => finishes).toBe(before + 1);
    await f.attach("global-default");
  }
  expect(starts).toEqual([undefined, "wake", undefined, undefined]);
  expect(finishes).toBe(4);
});
