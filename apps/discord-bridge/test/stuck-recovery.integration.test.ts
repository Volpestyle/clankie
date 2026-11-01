import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { REST } from "discord.js";
import { expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import {
  DiscordBridgeReceiptStore,
  DiscordPresenceSession,
  DiscordTextIngress,
  createAdvertisedDiscordPresencePort,
  readDiscordBridgeReceipts,
  type DiscordTextIngressEvidence,
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

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/stuck-recovery-deliveries.json", import.meta.url), "utf8"),
) as { rows: Record<string, unknown>[] };

// VUH-2394: the live inbox replayed these every minute for weeks. The service
// began recording delivery origins after they were sent, so it refuses their
// reply and its reconciliation. Real service, SQLite inbox and discord.js REST;
// Discord itself is a loopback fixture.
it("settles the real stuck deliveries terminally without posting, and backs transient failures off", async () => {
  const root = await mkdtemp(join(tmpdir(), "discord-stuck-recovery-"));
  const overrides = {
    XDG_CONFIG_HOME: join(root, "config"),
    CLANKIE_CREDENTIALS_FILE: join(root, "credentials.json"),
    CLANKIE_MODELS_PATH: join(root, "catalog.json"),
    CLANKIE_DISABLE_MODELS_FETCH: "1",
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  await writeFile(overrides.CLANKIE_MODELS_PATH, "{}");
  let discordReads = 0;
  let discordPosts = 0;
  const discord = createServer(async (request, response) => {
    for await (const _ of request) {
      /* consume */
    }
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url?.includes("/messages")) discordReads += 1;
    else if (request.method === "POST" && request.url?.includes("/messages")) discordPosts += 1;
    response.end(request.method === "GET" ? "[]" : "{}");
  });
  discord.listen(0, "127.0.0.1");
  await once(discord, "listening");
  const port = (server: typeof discord) => {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("fixture not listening");
    return address.port;
  };
  const rest = () =>
    new REST({ version: "10", api: `http://127.0.0.1:${port(discord)}` }).setToken("fixture");
  const runtime = new DiscordBotPresenceRuntime({ botToken: "fixture", rest: rest() });
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    discord: {
      ...current.discord,
      ownerUserId: "30000",
      servers: [{ serverId: "40000", role: "participant", owners: "me" }],
      textIngressEnabled: true,
      ingressGuildIds: ["40000"],
    },
  }));
  const captain = createCaptain(
    {
      herdrAvailable: () => false,
      embodiment: {},
      discordActions: {
        serverAction: async () => ({ ok: true, message: "Loopback Discord metadata" }),
        execute: async () => {
          throw new Error("No captain turn runs here");
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
  const leases = new BodyLeaseStore(join(root, "body"));
  const service = await createClankieApp({
    extensionRoutes: [personaRoutes()],
    captain,
    settings,
    roomObservations: new DiscordRoomObservations(join(root, "rooms.json")),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-operator"
        ? { operatorId: "fixture-owner" }
        : undefined,
    discordEnvironment: {},
    // As live: no `discord:<id>` origin predates the receipts these messages missed.
    discordTurnReceipts: new DiscordTurnReceipts(join(root, "receipts.json")),
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
      router: new BodyLeaseRouter(leases),
      confirmStopped: async (_resource, guard) => {
        await guard();
        return false;
      },
    },
  });
  let serviceDown = false;
  const presenceActions: string[] = [];
  const http = createServer(async (incoming, response) => {
    let body = "";
    for await (const chunk of incoming) body += chunk;
    if (serviceDown) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "captain_execution_unavailable" }));
      return;
    }
    if (incoming.url?.startsWith("/v1/discord/presence-actions")) presenceActions.push(incoming.url);
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

  // The live inbox's schema before this fix, holding the sanitized live rows.
  const inboxPath = join(root, "inbox.sqlite");
  const legacy = new DatabaseSync(inboxPath);
  legacy.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE deliveries (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, guild_id TEXT,
      request TEXT, result TEXT, reply TEXT, done INTEGER NOT NULL DEFAULT 0,
      outgoing TEXT, retries INTEGER NOT NULL DEFAULT 0, acknowledged INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO metadata VALUES ('seeded_v3', '1');
  `);
  const insert = legacy.prepare(
    "INSERT INTO deliveries (id, channel_id, guild_id, request, result, reply, done, outgoing, retries, acknowledged) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of fixture.rows)
    insert.run(
      String(row.id),
      String(row.channel_id),
      String(row.guild_id),
      JSON.stringify(row.request),
      JSON.stringify(row.result),
      null,
      Number(row.done),
      JSON.stringify(row.outgoing),
      Number(row.retries),
      Number(row.acknowledged),
    );
  legacy.close();
  let inbox = new DiscordTextInbox(inboxPath, "0");
  const ids = fixture.rows.map((row) => String(row.id));
  const evidence: DiscordTextIngressEvidence[] = [];
  const reports: Promise<void>[] = [];
  const ingress = new DiscordTextIngress(
    inbox.port(createAdvertisedDiscordPresencePort(client, presence)),
    {
      observationSessionId: () => presence.record.sessionId,
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
    // The bridge's own report path: room health hears every outcome.
    (event) => {
      evidence.push(event);
      if (event.observationSessionId !== undefined)
        reports.push(
          // Lost while the service is down, exactly as the bridge loses them.
          client
            .recordDiscordRoomEvidence({
              id: `${event.deliveryId}:${event.outcome}`,
              presenceSessionId: event.observationSessionId,
              transportKind: "bot",
              deliveryId: event.deliveryId,
              channelId: event.channelId,
              actorId: event.actorId,
              ...(event.guildId === undefined ? {} : { guildId: event.guildId }),
              outcome: event.outcome,
              ...(event.reason === undefined ? {} : { reason: event.reason }),
            })
            .catch((error: unknown) => {
              if (!serviceDown) throw error;
            }),
        );
    },
  );
  // One recovery round, as `recoverTextInbox` drives it.
  let now = Date.now();
  const round = async () => {
    for (const delivery of inbox.due(now))
      await inbox.handle(delivery.id, async () => {
        const result = await ingress.handle({
          id: delivery.id,
          guildId: "40000",
          channelId: "50000",
          authorId: "30001",
          authorIsBot: false,
          mentionsBot: false,
          body: "[stripped]",
          catchingUp: true,
        });
        if (result.state === "failed") inbox.retryLater(delivery.id, now);
      });
    await Promise.all(reports.splice(0));
  };
  const refusals = () => {
    const db = new DatabaseSync(inboxPath, { readOnly: true });
    try {
      return db
        .prepare("SELECT id, refusals, terminal FROM deliveries ORDER BY id")
        .all()
        .map((row) => ({ ...row }));
    } finally {
      db.close();
    }
  };
  const roomStatus = async () => {
    const response = await fetch(`http://127.0.0.1:${port(http)}/v1/discord/rooms`, {
      headers: { authorization: "Bearer fixture-operator" },
    });
    expect(response.status).toBe(200);
    const snapshot = await response.json();
    return snapshot.rooms.find((room: { conversationId: string }) => room.conversationId === roomId);
  };
  try {
    expect(inbox.due(now).map((row) => row.id)).toEqual(ids);

    // Transient: the service is down. Never terminal, however often it fails,
    // and each retry waits longer, up to ten minutes.
    serviceDown = true;
    const waits: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const before = now;
      await round();
      expect(inbox.due(now)).toEqual([]);
      while (inbox.due(now).length === 0) now += 1_000;
      waits.push(now - before);
    }
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000]);
    expect(refusals()).toEqual(ids.map((id) => ({ id, refusals: 0, terminal: null })));
    expect(presenceActions).toEqual([]);

    // Permanent: the real refusal. Bounded, then never asked again.
    serviceDown = false;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await round();
      expect(refusals().map((row) => row.refusals)).toEqual([attempt, attempt]);
      now += 600_000;
    }
    expect(refusals()).toEqual(
      ids.map((id) => ({ id, refusals: 3, terminal: "discord_reply_reconciliation_origin_required" })),
    );
    expect(presenceActions).toHaveLength(6);
    expect(presenceActions.every((url) => url.endsWith("?reconcile=1"))).toBe(true);
    expect(inbox.pending()).toEqual([]);
    expect(
      evidence
        .filter((event) => event.outcome === "abandoned")
        .map((event) => [event.deliveryId, event.reason]),
    ).toEqual(ids.map((id) => [id, "discord_reply_reconciliation_origin_required"]));
    expect(await roomStatus()).toMatchObject({ abandoned: 2, unrecoveredFailed: 0, failed: 0, pending: 0 });

    // A restart's legacy-failure repair must not reopen them.
    inbox.close();
    inbox = new DiscordTextInbox(inboxPath, "0");
    let ran = false;
    for (const id of ids)
      await inbox.handle(id, async () => {
        ran = true;
      });
    now += 3_600_000;
    expect(inbox.due(now)).toEqual([]);
    expect(ran).toBe(false);
    expect(presenceActions).toHaveLength(6);
    // Nothing reached the room: no stale answer, no weeks-late notice, no read.
    expect({ discordPosts, discordReads }).toEqual({ discordPosts: 0, discordReads: 0 });
  } finally {
    inbox.close();
    await service.close();
    await captain.close();
    leases.close();
    await Promise.all(
      [http, discord].map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
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
}, 60_000);

it("bounds the receipt journal, collapsing a retry storm, while an inbox rebuild still finds its deliveries", async () => {
  const root = await mkdtemp(join(tmpdir(), "discord-receipt-journal-"));
  try {
    const path = join(root, "receipts.jsonl");
    const maxBytes = 64 * 1024;
    const receipts = new DiscordBridgeReceiptStore({ path, maxBytes });
    const event = (deliveryId: string, outcome: string, reason?: string) =>
      receipts.append("discord.text.ingress", {
        deliveryId,
        correlationId: `discord-message:${deliveryId}`,
        presenceSessionId: "discord:40000:50000",
        guildId: "40000",
        channelId: "50000",
        outcome,
        ...(reason === undefined ? {} : { reason }),
      });
    await receipts.append("discord.voice.joined", { type: "joined", guildId: "40000", channelId: "50001" });
    await event("1551000000000000001", "accepted");
    await event("1551000000000000001", "settled");
    // The live storm: accepted, failed, failed, every round.
    for (let index = 0; index < 400; index += 1)
      await Promise.all([
        event("1551841084403875931", "accepted"),
        event("1551841084403875931", "failed", "discord_saved_request_missing"),
        event(
          "1551841084403875931",
          "failed",
          'Clankie API 403: {"error":"discord_reply_reconciliation_origin_required"}',
        ),
      ]);
    await event("1561100000000000000", "accepted");
    expect((await stat(path)).size).toBeLessThanOrEqual(maxBytes);
    const kept = await readDiscordBridgeReceipts(path);
    expect(kept.map((receipt) => [receipt.type, receipt.data.deliveryId, receipt.data.outcome])).toEqual([
      ["discord.voice.joined", undefined, undefined],
      ["discord.text.ingress", "1551000000000000001", "accepted"],
      ["discord.text.ingress", "1551000000000000001", "settled"],
      ["discord.text.ingress", "1551841084403875931", "accepted"],
      ["discord.text.ingress", "1551841084403875931", "failed"],
      ["discord.text.ingress", "1551841084403875931", "failed"],
      ["discord.text.ingress", "1561100000000000000", "accepted"],
    ]);
    const inbox = new DiscordTextInbox(join(root, "inbox.sqlite"), "0");
    try {
      await inbox.seedReceipts(path);
      expect(inbox.pending().map((row) => row.id)).toEqual(["1551841084403875931", "1561100000000000000"]);
    } finally {
      inbox.close();
    }
    // Nothing repeats: the oldest receipts give way, the newest stay.
    for (let index = 0; index < 600; index += 1)
      await event(String(1562000000000000000n + BigInt(index)), "accepted");
    expect((await stat(path)).size).toBeLessThanOrEqual(maxBytes);
    const flooded = await readDiscordBridgeReceipts(path);
    expect(flooded[0]?.type).toBe("discord.text.ingress");
    expect(flooded.at(-1)?.data.deliveryId).toBe("1562000000000000599");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
