import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { REST } from "discord.js";
import { readableMcpResult } from "@clankie/protocol/mcp-result";
import { expect, it } from "vitest";
import { updateGlobalConfig } from "../../../packages/model-provider/src/config.ts";
import { SettingsStore } from "@clankie/settings";
import {
  DiscordTextIngress,
  DiscordPresenceSession,
  createAdvertisedDiscordPresencePort,
  DISCORD_TURN_FAILED_NOTICE,
} from "@clankie/discord-presence-core";
import { ClankieApiClient } from "@clankie/api-client";
import { createClankieApp, createBearerAuthenticator } from "../../clankie/src/app.ts";
import { personaRoutes } from "../../clankie/src/persona-extension.ts";
import { DiscordTurnReceipts } from "../../clankie/src/captain/discord-turn-receipts.ts";
import { BodyLeaseStore } from "../../clankie/src/body-leases.ts";
import { BodyLeaseRouter } from "../../clankie/src/body-lease-router.ts";
import { createCaptain } from "../../clankie/src/captain/captain.ts";
import type { CaptainDeps } from "../../clankie/src/captain/deps.ts";
import { DiscordRoomObservations } from "../../clankie/src/discord-room-observations.ts";
import { DiscordTextInbox } from "../src/text-inbox.ts";
import { DiscordBotPresenceRuntime } from "../src/bot-presence-runtime.ts";

// Real Pi/model HTTP, handoff journals, SQLite inbox and discord.js REST.
// Both remote services are owned loopback fixtures, never real Discord rooms.
it("recovers an outage once, delivers saved answers to their original room and acknowledges a repeated failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "discord-recovery-"));
  const overrides = {
    XDG_CONFIG_HOME: join(root, "config"),
    CLANKIE_CREDENTIALS_FILE: join(root, "credentials.json"),
    CLANKIE_MODELS_PATH: join(root, "catalog.json"),
    CLANKIE_DISABLE_MODELS_FETCH: "1",
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  await writeFile(overrides.CLANKIE_MODELS_PATH, "{}");
  let modelUp = false;
  let modelCalls = 0;
  let discordUp = true;
  let loseAcknowledgement = false;
  let historyAvailable = true;
  let discordReads = 0;
  const posts: {
    id: string;
    author: { id: string };
    content: string;
    message_reference: { message_id: string };
    channel: string;
  }[] = [];
  let audienceReads = 0;
  const model = createServer(async (request, response) => {
    for await (const _ of request) {
      /* consume the actual provider request */
    }
    modelCalls += 1;
    if (!modelUp) {
      response.writeHead(400);
      response.end(JSON.stringify({ error: { message: "fixture model outage" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const frame = (delta: object, finish: string | null) =>
      `data: ${JSON.stringify({
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "local",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    response.end(
      frame({ role: "assistant", content: "The saved room answer." }, null) +
        frame({}, "stop") +
        "data: [DONE]\n\n",
    );
  });
  const discord = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://fixture");
    url.pathname = decodeURIComponent(url.pathname);
    response.setHeader("content-type", "application/json");
    if (url.pathname.endsWith("/users/@me")) {
      response.end(JSON.stringify({ id: "90000" }));
      return;
    }
    if (url.pathname.endsWith("/typing")) {
      response.removeHeader("content-type");
      response.writeHead(204);
      response.end();
      return;
    }
    if (/\/channels\/[^/]+$/.test(url.pathname)) {
      audienceReads += 1;
      response.end(JSON.stringify({ id: "50000", guild_id: "40000", permission_overwrites: [] }));
      return;
    }
    const channel = /\/channels\/([^/]+)\/messages/.exec(url.pathname)?.[1];
    if (!channel) {
      console.error("Unknown fixture route", request.method, url.pathname);
      response.writeHead(404);
      response.end("{}");
      return;
    }
    if (request.method === "GET") {
      discordReads += 1;
      if (!historyAvailable) {
        response.writeHead(403);
        response.end(JSON.stringify({ message: "fixture history unavailable", code: 50001 }));
        return;
      }
      response.end(
        JSON.stringify(
          posts.filter(
            (post) =>
              post.channel === channel && BigInt(post.id) > BigInt(url.searchParams.get("after") ?? "0"),
          ),
        ),
      );
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    if (url.pathname.endsWith("/typing")) {
      response.removeHeader("content-type");
      response.writeHead(204);
      response.end();
      return;
    }
    if (!discordUp) {
      response.writeHead(400);
      response.end(JSON.stringify({ message: "fixture Discord outage", code: 50001 }));
      return;
    }
    const payload = JSON.parse(body);
    const post = { ...payload, id: String(100000 + posts.length), author: { id: "90000" }, channel };
    posts.push(post);
    if (loseAcknowledgement) {
      response.writeHead(400);
      response.end(JSON.stringify({ message: "fixture lost acknowledgement", code: 50001 }));
      return;
    }
    response.end(JSON.stringify(post));
  });
  model.listen(0, "127.0.0.1");
  discord.listen(0, "127.0.0.1");
  await Promise.all([once(model, "listening"), once(discord, "listening")]);
  const port = (server: typeof model) => {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("fixture not listening");
    return address.port;
  };
  const runtime = new DiscordBotPresenceRuntime({
    botToken: "fixture",
    rest: new REST({ version: "10", api: `http://127.0.0.1:${port(discord)}` }).setToken("fixture"),
  });
  await updateGlobalConfig((config) => {
    config.enabled_providers = ["recovery-fixture"];
    config.model = "recovery-fixture/local";
    config.routing = { routine_model: config.model, escalate: false };
    config.provider = {
      "recovery-fixture": {
        name: "recovery fixture",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `http://127.0.0.1:${port(model)}/v1` },
        models: { local: { name: "local", limit: { context: 100000, output: 512 } } },
      },
    };
  });
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    discord: {
      ...current.discord,
      ownerUserId: "30000",
      servers: [{ serverId: "40000", role: "participant", owners: "me" }],
    },
  }));
  // This fixture has no installed tools or retained memories. Only its model
  // provider and Discord transport are enabled; no implementation is mocked.
  const captain = createCaptain(
    {
      herdrAvailable: () => false,
      embodiment: {},
      discordActions: {
        serverAction: async (action: { path: string }) => ({
          ok: true,
          message: "Loopback Discord metadata",
          data: await new REST({ version: "10", api: `http://127.0.0.1:${port(discord)}` })
            .setToken("fixture")
            .get(action.path as Parameters<REST["get"]>[0]),
        }),
        execute: async () => {
          throw new Error("Refused room turn must not post");
        },
      },
      memory: {
        recallEpisodeCard: async () => "",
        searchEpisodeCard: async () => "",
        recallDiscordPerson: () => "",
      },
      mcp: { catalog: async () => [] },
      browser: { catalog: async () => ({ available: false, tools: [] }) },
    } as unknown as CaptainDeps,
    {
      repoRoot: root,
      stateDir: join(root, "captain"),
      settings,
      discordEnvironment: {},
      personaImages: async () => ({ images: [], hash: "fixture", files: [] }),
    },
  );
  const roomId = captain.bodyRoomConversation("discord_presence", "40000:50000");
  const observations = new DiscordRoomObservations(join(root, "rooms.json"));
  const inboxPath = join(root, "inbox.sqlite");
  let inbox = new DiscordTextInbox(inboxPath, "0");
  const receipts = new DiscordTurnReceipts(join(root, "receipts.json"));
  const leases = new BodyLeaseStore(join(root, "body"));
  const router = new BodyLeaseRouter(leases);
  const service = await createClankieApp({
    extensionRoutes: [personaRoutes()],
    captain,
    settings,
    roomObservations: observations,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-operator"
        ? { operatorId: "fixture-owner" }
        : undefined,
    discordEnvironment: {},
    discordTurnReceipts: receipts,
    eventLogPath: join(root, "events.jsonl"),
    authenticateCaptain: createBearerAuthenticator("fixture-captain", {
      captainId: "fixture-body",
      steerSourceLane: "discord_text",
      discordTransportKind: "bot",
    }),
    discordPresenceRuntime: {
      execute: runtime.execute.bind(runtime),
      reconcileReply: runtime.reconcileReply.bind(runtime),
    },
    bodyLeases: {
      store: leases,
      router,
      confirmStopped: async (_resource, guard) => {
        await guard();
        return false;
      },
    },
  });
  const http = createServer(async (incoming, response) => {
    let body = "";
    for await (const chunk of incoming) body += chunk;
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers))
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
    const result = await service.app.fetch(
      new Request(`http://127.0.0.1${incoming.url}`, {
        method: incoming.method!,
        headers,
        ...(body ? { body } : {}),
      }),
    );
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(await result.text());
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const client = new ClankieApiClient({
    baseUrl: `http://127.0.0.1:${port(http)}`,
    captainToken: "fixture-captain",
  });
  const roomStatus = async () => {
    const response = await fetch(`http://127.0.0.1:${port(http)}/v1/discord/rooms`, {
      headers: { authorization: "Bearer fixture-operator" },
    });
    expect(response.status).toBe(200);
    const snapshot = await response.json();
    return snapshot.rooms.find((room: { conversationId: string }) => room.conversationId === roomId);
  };
  const presence = new DiscordPresenceSession({
    sessionId: "fixture-body",
    characterId: "clankie",
    credentialRef: "discord_bot",
    transportKind: "bot",
    emit: async (event) => (await client.recordDiscordPresencePhase(event)).session,
  });
  await presence.start();
  await presence.gatewayReady();
  const delegate = createAdvertisedDiscordPresencePort(client, presence);
  const ingress = () =>
    new DiscordTextIngress(
      inbox.port(delegate),
      {
        characterId: "clankie",
        credentialRef: "discord_bot",
        transportKind: "bot",
        guildIds: new Set(["40000"]),
        channelIds: new Set(),
        dmPolicy: "owner_only",
        ownerUserId: "30000",
        dmUserIds: new Set(),
        contextMessageLimit: 0,
        authenticatedSurfaceUrl: "http://fixture",
      },
      // Deliberately lose bridge health reports. Durable service receipts
      // must still supply the counters the rooms API and doctor consume.
    );
  const message = (id: string, channelId = "50000") => ({
    id,
    channelId,
    guildId: "40000",
    authorId: "30000",
    authorIsBot: false,
    mentionsBot: true,
    body: "Answer this fixture question.",
  });
  const restart = (legacyFailed = false) => {
    inbox.close();
    if (legacyFailed) {
      const db = new DatabaseSync(inboxPath);
      db.prepare("UPDATE deliveries SET done = 1 WHERE id = '100'").run();
      db.close();
    }
    inbox = new DiscordTextInbox(inboxPath, "0");
    return ingress();
  };
  try {
    let body = ingress();
    expect((await body.handle(message("100"))).state).toBe("failed");
    expect(posts).toHaveLength(0);
    expect(inbox.pending()).toHaveLength(1);
    expect(await roomStatus()).toMatchObject({ failed: 1, unrecoveredFailed: 1, pending: 0 });
    const tool = (await captain.laneToolBank("operator", "global-default")).tools.find(
      (entry) => entry.name === "room_turn",
    )!;
    // The loopback channel names no text type, so the fork is refused before any turn.
    const refused = await tool.call({ channel: "50000", brief: "Test channel refusal." });
    const projected = readableMcpResult({ ...refused, content: [...refused.content] }, "room_turn");
    const callerCause = projected.content.find((block) => block.type === "text")?.text;
    expect(callerCause).toContain("room_fork_not_a_text_room");
    expect(audienceReads).toBeGreaterThan(0);
    expect(posts).toHaveLength(0);
    const reprojected = readableMcpResult(
      {
        ...projected,
        content: [{ type: "text", text: "room turn: failed." }],
      },
      "room_turn",
    );
    expect(reprojected.content[0]?.text).toContain("room_fork_not_a_text_room");
    const before = modelCalls;
    modelUp = true;
    body = restart(true);
    const recovered = await body.handle(message("100"));
    if (recovered.state !== "settled")
      throw new Error(JSON.stringify({ recovered, modelCalls, pending: inbox.pending() }));
    expect(modelCalls).toBe(before + 1);
    expect(posts).toMatchObject([
      { channel: "50000", message_reference: { message_id: "100" }, content: "The saved room answer." },
    ]);
    expect(await roomStatus()).toMatchObject({ failed: 0, unrecoveredFailed: 0, pending: 0, answered: 1 });
    expect(observations.status(roomId).lastReason).not.toBe("captain_session_failed");
    body = restart();
    await inbox.handle("100", async () => {
      await body.handle(message("100"));
    });
    expect(posts).toHaveLength(1);

    discordUp = false;
    expect((await body.handle(message("101", "50001"))).state).toBe("failed");
    discordUp = true;
    // The abandoned mouth blocks another room's completed answer too.
    expect((await body.handle(message("103", "50002"))).state).toBe("failed");
    const completedCalls = modelCalls;
    body = restart();
    expect((await body.handle(message("101", "50001"))).state).toBe("failed");
    const held = leases.status("discord_mouth")!;
    expect(receipts.writesSettled(held.conversationId)).toBe(true);
    expect(
      (
        await router.recoverIdle(
          "discord_mouth",
          () => true,
          async (guard) => {
            await guard();
            return receipts.writesSettled(held.conversationId);
          },
          () => true,
        )
      ).outcome,
    ).toBe("released");
    expect((await body.handle(message("101", "50001"))).state).toBe("settled");
    expect(modelCalls).toBe(completedCalls);
    expect(posts[1]).toMatchObject({ channel: "50001", message_reference: { message_id: "101" } });
    expect((await body.handle(message("103", "50002"))).state).toBe("settled");
    expect(modelCalls).toBe(completedCalls);
    expect(posts[2]).toMatchObject({ channel: "50002", message_reference: { message_id: "103" } });

    modelUp = false;
    await body.handle(message("102"));
    body = restart();
    await body.handle(message("102"));
    expect(posts.at(-1)?.content).toBe(DISCORD_TURN_FAILED_NOTICE);
    const failedCalls = modelCalls;
    body = restart();
    await inbox.handle("102", async () => {
      await body.handle(message("102"));
    });
    expect(modelCalls).toBe(failedCalls);
    expect(posts).toHaveLength(4);
    expect(inbox.pending()).toHaveLength(0);

    // Discord accepted the answer but the acknowledgement was lost. A restart
    // must confirm the existing reply instead of posting or running tools again.
    modelUp = true;
    loseAcknowledgement = true;
    expect((await body.handle(message("104"))).state).toBe("failed");
    const lostAckCalls = modelCalls;
    expect(posts).toHaveLength(5);
    loseAcknowledgement = false;
    historyAvailable = false;
    body = restart();
    expect((await body.handle(message("104"))).state).toBe("failed");
    expect(modelCalls).toBe(lostAckCalls);
    expect(posts).toHaveLength(5);
    expect(receipts.writesSettled(leases.status("discord_mouth")!.conversationId)).toBe(false);
    historyAvailable = true;
    const outgoing = JSON.parse(inbox.pending()[0]!.outgoing!);
    const reads = discordReads;
    const claim = {
      schemaVersion: 1 as const,
      sessionId: presence.liveRecord.sessionId,
      phase: presence.liveRecord.phase,
      revision: presence.liveRecord.revision,
    };
    await expect(
      client.reconcileDiscordPresenceAction(
        { ...outgoing, payload: { ...outgoing.payload, channelId: "60000" } },
        claim,
      ),
    ).rejects.toThrow();
    await expect(
      client.reconcileDiscordPresenceAction(outgoing, { ...claim, revision: claim.revision - 1 }),
    ).rejects.toThrow();
    expect(discordReads).toBe(reads);
    body = restart();
    expect((await body.handle(message("104"))).state).toBe("settled");
    expect(modelCalls).toBe(lostAckCalls);
    expect(posts).toHaveLength(5);
    expect(inbox.pending()).toHaveLength(0);
    const reconciledMouth = leases.status("discord_mouth")!;
    expect(
      (
        await router.recoverIdle(
          "discord_mouth",
          () => true,
          async (guard) => {
            await guard();
            return receipts.writesSettled(reconciledMouth.conversationId);
          },
          () => true,
        )
      ).outcome,
    ).toBe("released");

    // Legacy done row: its accepted request and result were lost. Receipt
    // seeding must reopen it and ask for a resend without another model run.
    modelUp = false;
    await body.handle(message("105"));
    await body.handle(message("107"));
    inbox.close();
    const legacy = new DatabaseSync(inboxPath);
    legacy
      .prepare(
        "UPDATE deliveries SET done = 1, request = NULL, result = NULL, acknowledged = 0 WHERE id = '105'",
      )
      .run();
    legacy
      .prepare(
        "UPDATE deliveries SET done = 1, request = '{}', result = NULL, acknowledged = 0 WHERE id = '107'",
      )
      .run();
    legacy.prepare("INSERT OR REPLACE INTO metadata VALUES ('seeded_v2', '1')").run();
    legacy.close();
    const legacyLog = join(root, "legacy.jsonl");
    await writeFile(
      legacyLog,
      ["105", "107"]
        .flatMap((deliveryId) =>
          ["accepted", "failed"].map((outcome) =>
            JSON.stringify({
              type: "discord.text.ingress",
              data: { deliveryId, channelId: "50000", guildId: "40000", outcome },
            }),
          ),
        )
        .join("\n") + "\n",
    );
    inbox = new DiscordTextInbox(inboxPath, "0");
    await inbox.seedReceipts(legacyLog);
    expect(inbox.pending().map((row) => row.id)).toContain("105");
    const legacyCalls = modelCalls;
    modelUp = true;
    body = ingress();
    for (const id of ["105", "107"]) {
      await inbox.handle(id, async () => {
        await body.handle(message(id));
      });
      expect(posts.filter((post) => post.message_reference.message_id === id)).toMatchObject([
        { content: DISCORD_TURN_FAILED_NOTICE },
      ]);
    }
    expect(modelCalls).toBe(legacyCalls);
    body = restart();
    await inbox.seedReceipts(legacyLog);
    for (const id of ["105", "107"]) {
      await inbox.handle(id, async () => {
        await body.handle(message(id));
      });
      expect(posts.filter((post) => post.message_reference.message_id === id)).toHaveLength(1);
    }
    expect(await roomStatus()).toMatchObject({ failed: 0, pending: 0, unrecoveredFailed: 0 });
    // Restoration is exercised, not inferred: the next fresh message answers.
    expect((await body.handle(message("106"))).state).toBe("settled");
    expect(posts.at(-1)?.content).toBe("The saved room answer.");
    const repaired = new DiscordRoomObservations(join(root, "repaired-rooms.json"));
    for (const evidence of new DiscordTurnReceipts(join(root, "receipts.json")).roomEvidence())
      repaired.record(
        captain.bodyRoomConversation("discord_presence", `${evidence.guildId ?? "dm"}:${evidence.channelId}`),
        evidence,
      );
    expect(repaired.status(roomId)).toMatchObject({
      failed: 0,
      pending: 0,
      unrecoveredFailed: 0,
      answered: observations.status(roomId).answered,
    });
    if (process.env.VUH_2142_PROOF_PATH)
      await writeFile(
        process.env.VUH_2142_PROOF_PATH,
        JSON.stringify({
          modelRestored: modelUp,
          callerCause,
          legacyNoticeCounts: ["105", "107"].map((id) => ({
            id,
            posts: posts.filter((post) => post.message_reference.message_id === id).length,
          })),
          counters: await roomStatus(),
          inboxPending: inbox.pending().length,
          repairedCounters: repaired.status(roomId),
          posts,
        }),
      );
  } finally {
    inbox.close();
    await service.close();
    await captain.close();
    leases.close();
    await new Promise<void>((resolve) => {
      http.close(() => resolve());
      http.closeAllConnections();
    });
    await Promise.all(
      [model, discord].map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          }),
      ),
    );
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
