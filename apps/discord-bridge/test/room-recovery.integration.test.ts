import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { REST } from "discord.js";
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
  const observations = new DiscordRoomObservations(join(root, "rooms.json"));
  const inboxPath = join(root, "inbox.sqlite");
  let inbox = new DiscordTextInbox(inboxPath, "0");
  const receipts = new DiscordTurnReceipts(join(root, "receipts.json"));
  const leases = new BodyLeaseStore(join(root, "body"));
  const router = new BodyLeaseRouter(leases);
  const service = await createClankieApp({
    captain,
    settings,
    roomObservations: observations,
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
      (evidence) =>
        observations.record("room", {
          ...evidence,
          id: `${evidence.deliveryId}:${evidence.outcome}`,
          transportKind: "bot",
        }),
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
    expect(observations.status("room").unrecoveredFailed).toBe(1);
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
    expect(observations.status("room").unrecoveredFailed).toBe(0);
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
