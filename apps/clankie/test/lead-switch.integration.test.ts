import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceResultSchema,
  SENDER_DEVICE_SESSION_HEADER,
  SUPERVISE_GRANTS,
  TAKE_CONTROL_GRANTS,
} from "@clankie/protocol";
import type { CaptainReadinessResponse } from "@clankie/protocol/captain-readiness";
import { FLEET_LEADS_PATH, FleetLeadsSnapshotSchema } from "@clankie/protocol/fleet-leads";
import { SettingsStore } from "@clankie/settings";
import { expect, it } from "vitest";
import type { SeatQuestion } from "@clankie/agent-hosts";
import {
  createFauxCore,
  fauxAssistantMessage,
  InMemoryCredentialStore,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createEvalResources, createEvalSettings } from "../src/captain/eval-session-boundary.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import type { CaptainModelRuntime } from "../src/captain/model.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";
import {
  createCaptainConversationDispatch,
  createDeviceConversationDispatch,
} from "../../relay/src/conversation-upstream.ts";
import { ControlPlaneDeviceAuthorizer } from "../../relay/src/device-auth.ts";
import { createOperatorConversationRelayHandler } from "../../relay/src/operator-conversations.ts";

// Clankie's on/off switch (ADR 0350): a real captain and service behind the real
// relay. The owner's own Take Control phone switches him off and on; an app
// signed in to the connector, a Supervise device and the captain bearer can't
// set it either way. Off is shown as off on the hearth, and turning him on
// replays nothing that was held.

const LEAD = "global-default";
const RELAY_BEARER = randomBytes(24).toString("hex");

it("lets the owner's own phone switch Clankie off and on through the relay, and nobody else", async () => {
  const root = await mkdtemp(join(tmpdir(), "lead-switch-"));
  let turns = 0;
  const captain = createCaptain(
    {
      herdrAvailable: () => false,
      onTurnSettled: () => turns++,
      runtimes: {
        list: async () => [],
        onChange: () => () => undefined,
        configuredBinding: async () => undefined,
      },
      browser: { catalog: async () => ({ schemaVersion: 1, available: false, tools: [] }) },
      mcp: { catalog: async () => [] },
      media: { finishedRenders: async () => [] },
      embodiment: {
        submitIntent: async () => {
          throw new Error("No body in this fixture");
        },
        getSession: async () => undefined,
        getLiveSession: async () => undefined,
      },
      memory: {
        appendEpisode: async () => ({ corrected: false, retained: false }),
        recallEpisodeCard: async () => "",
        searchEpisodeCard: async () => "",
      },
    } as unknown as CaptainDeps,
    {
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      settings: new SettingsStore(join(root, "settings.json")),
    },
  );
  await captain.serveOperatorConversation({ op: "fleet", schemaVersion: 1 });

  // Three paired devices: the owner's phone, a Supervise-only watcher, and Claude
  // signed in to the connector, which holds Take Control grants too.
  const now = Date.now();
  const iso = (offset = 0) => new Date(now + offset).toISOString();
  const key = randomBytes(32);
  const signer = new DeviceSessionSigner(key);
  const devices = {
    phone: { grants: TAKE_CONTROL_GRANTS },
    watcher: { grants: SUPERVISE_GRANTS },
    claude: { grants: TAKE_CONTROL_GRANTS, scope: "connector" as const },
  };
  const events = Object.entries(devices).flatMap(([deviceId, device]) => {
    const event = (type: string, data: object) => ({
      id: randomUUID(),
      type,
      occurredAt: iso(-60_000),
      missionId: `device:${deviceId}`,
      correlationId: "lead-switch-proof",
      profileHash: "fixture",
      data: { schemaVersion: 1, deviceId, ...data },
    });
    return [
      event("device.pairing.redeemed", {
        offerId: deviceId,
        name: deviceId,
        platform: "ios",
        offeredGrants: device.grants,
        mintedBy: "local-operator",
        pendingExpiresAt: iso(60_000),
        ...("scope" in device ? { scope: device.scope } : {}),
      }),
      event("device.activated", { grants: device.grants, sessionExpiresAt: iso(60 * 60_000) }),
    ];
  });
  const eventLogPath = join(root, "devices.jsonl");
  await writeFile(eventLogPath, events.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const token = (deviceId: keyof typeof devices) =>
    signer.issue(
      mintDeviceSessionClaims({ deviceId, nowEpochSeconds: Math.floor(now / 1000), ttlSeconds: 3600 }),
    );

  let readiness: CaptainReadinessResponse = { ready: true, model: "openai/gpt-test", providerId: "openai" };
  const service = await createClankieApp({
    captain,
    deviceSessionKey: key,
    eventLogPath,
    modelKeys: { readiness: async () => readiness } as never,
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === `Bearer ${RELAY_BEARER}`
        ? { captainId: "relay", steerSourceLane: "api" }
        : undefined,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  const server = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const handler = createOperatorConversationRelayHandler({
    authorizeDevice: new ControlPlaneDeviceAuthorizer({ baseUrl }),
    dispatch: createCaptainConversationDispatch({ baseUrl, bearerToken: RELAY_BEARER }),
    deviceDispatch: createDeviceConversationDispatch({ baseUrl }),
  });
  const relay = createServer((request, response) => {
    void (async () => {
      if (await handler(request, response)) return;
      response.statusCode = 404;
      response.end();
    })();
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;

  const viaRelay = (deviceId: keyof typeof devices, command: unknown) =>
    fetch(new URL(OPERATOR_CONVERSATION_DISPATCH_PATH, relayUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${token(deviceId)}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "lead", schemaVersion: 1, command }),
    });
  const leadStatus = async (response: Response) => {
    expect(response.status).toBe(200);
    const parsed = OperatorConversationServiceResultSchema.parse(await response.json());
    if (parsed.op !== "lead") throw new Error(`Unexpected op ${parsed.op}`);
    return parsed.result.status;
  };
  const hearth = async () => {
    const response = await fetch(new URL(FLEET_LEADS_PATH, baseUrl), {
      headers: { authorization: `Bearer ${token("phone")}` },
    });
    expect(response.status).toBe(200);
    return FleetLeadsSnapshotSchema.parse(await response.json()).leads.find((lead) => lead.id === "clankie")!;
  };

  try {
    // He starts on, and the phone reads the switch on its observe grant.
    expect(await leadStatus(await viaRelay("phone", { action: "status" }))).toMatchObject({
      lead: "clankie",
      clankie: { state: "on" },
    });
    expect((await hearth()).active).toBe(true);

    // The connector app and the Supervise watcher can't switch him, either way.
    for (const lead of ["apps", "clankie"]) {
      for (const deviceId of ["claude", "watcher"] as const)
        expect((await viaRelay(deviceId, { action: "set", lead })).status).toBe(403);
      // Nor can the captain bearer the relay itself dispatches on.
      const bearer = await fetch(new URL(OPERATOR_CONVERSATION_DISPATCH_PATH, baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${RELAY_BEARER}`, "content-type": "application/json" },
        body: JSON.stringify({ op: "lead", schemaVersion: 1, command: { action: "set", lead } }),
      });
      expect(bearer.status).toBe(403);
      // Nor the connector app's own device bearer straight at the service, which
      // never authenticates a connector outside the relay's allowlist (ADR 0301).
      const direct = await fetch(new URL(OPERATOR_CONVERSATION_DISPATCH_PATH, baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${token("claude")}`, "content-type": "application/json" },
        body: JSON.stringify({ op: "lead", schemaVersion: 1, command: { action: "set", lead } }),
      });
      expect(direct.status).toBe(401);
    }
    expect(JSON.parse(await readFile(join(root, "lead.json"), "utf8").catch(() => "{}"))).not.toMatchObject({
      lead: "apps",
    });

    // The owner's phone switches him off; his own turns are held, not run.
    expect(await leadStatus(await viaRelay("phone", { action: "set", lead: "apps" }))).toMatchObject({
      lead: "apps",
      clankie: { state: "off" },
    });
    expect(JSON.parse(await readFile(join(root, "lead.json"), "utf8"))).toMatchObject({ lead: "apps" });
    expect((await hearth()).active).toBe(false);
    expect(
      await captain.wakeConversation(
        { conversationId: LEAD },
        "Timer: check the release.",
        undefined,
        "machine",
        false,
      ),
    ).toBe(true);
    await expect
      .poll(async () => (await leadStatus(await viaRelay("phone", { action: "status" }))).held)
      .toBe(1);
    expect(turns).toBe(0);

    // While off, a model that can't run says so before he is turned on.
    readiness = { ready: false, reason: "no_credential", model: "openai/gpt-test", providerId: "openai" };
    expect(await leadStatus(await viaRelay("phone", { action: "status" }))).toMatchObject({
      lead: "apps",
      clankie: { state: "off", reason: "no_credential", message: expect.stringContaining("openai/gpt-test") },
    });

    // The phone switches him back on: the switch reads "can't start" while his model can't run.
    expect(await leadStatus(await viaRelay("phone", { action: "set", lead: "clankie" }))).toMatchObject({
      lead: "clankie",
      clankie: { state: "cant_start", reason: "no_credential" },
    });
    expect(JSON.parse(await readFile(join(root, "lead.json"), "utf8"))).toMatchObject({ lead: "clankie" });
    expect((await hearth()).active).toBe(true);
    readiness = { ready: true, model: "openai/gpt-test", providerId: "openai" };
    expect(await leadStatus(await viaRelay("phone", { action: "status" }))).toMatchObject({
      lead: "clankie",
      held: 1,
      clankie: { state: "on" },
    });
    // Turning him on flips the setting only: what was held is not replayed.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(turns).toBe(0);
  } finally {
    relay.closeAllConnections();
    relay.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
    service.close();
    await captain.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 60_000);

// The leak the review found: "not internal" is not proof the owner sent it. While
// off, the production runner answers only a send that carries the owner's
// verified identity, here his Supervise phone through the relay; a send on the
// bare captain bearer and a resolved-elsewhere worker notice are held. The model
// is an in-memory fake, so nothing reaches a real provider.
it("while off, the real runner answers the owner's Supervise phone and holds a bare captain-bearer send and a worker notice", async () => {
  const root = await mkdtemp(join(tmpdir(), "lead-switch-runner-"));
  const core = createFauxCore({ provider: "fake", api: "faux-fake", models: [{ id: "default" }] });
  const prompts: string[] = [];
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider("fake", {
    api: "faux-fake" as Api,
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "loopback",
    streamSimple: (model, context, options) => {
      const last = context.messages.at(-1);
      prompts.push(typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? ""));
      return core.streamSimple(model, context, options);
    },
    models: [
      {
        id: "default",
        name: "default",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 4_000,
      },
    ],
  });
  const selection = {
    model: runtime.getModel("fake", "default") as Model<Api>,
    thinkingLevel: "off" as const,
    ref: "fake/default",
  };
  const models: CaptainModelRuntime = {
    runtime,
    resolveSelection: async () => selection,
    resolveRoute: async (purpose) => ({ route: { purpose, tier: "work", ref: "fake/default" }, selection }),
  };
  core.setResponses([fauxAssistantMessage("Here, James.")]);
  // Capture the captain's own watch store to drive a real worker question through it.
  const started = vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  const question: SeatQuestion = {
    requestId: "ask-1",
    turnId: "turn-1",
    itemId: "item-1",
    isBlocking: true,
    questions: [
      {
        id: "q",
        header: "Route",
        question: "Choose",
        isOther: false,
        isSecret: false,
        options: [
          { label: "A", description: "A" },
          { label: "B", description: "B" },
        ],
      },
    ],
  };
  let workerAsking = true;
  vi.spyOn(HerdrWatchStore.prototype, "observedSeatQuestion").mockImplementation(async () => ({
    sessionId: "worker-session",
    question,
  }));
  vi.spyOn(HerdrWatchStore.prototype, "workerQuestionStatus").mockImplementation(async () =>
    workerAsking ? "pending" : "resolved",
  );
  let turns = 0;
  const captain = createCaptain(
    {
      herdrAvailable: () => false,
      onTurnSettled: () => turns++,
      runtimes: {
        list: async () => [],
        onChange: () => () => undefined,
        configuredBinding: async () => undefined,
      },
      browser: { catalog: async () => ({ schemaVersion: 1, available: false, tools: [] }) },
      mcp: { catalog: async () => [] },
      media: { finishedRenders: async () => [] },
      embodiment: {
        submitIntent: async () => {
          throw new Error("No body in this fixture");
        },
        getSession: async () => undefined,
        getLiveSession: async () => undefined,
      },
      memory: {
        appendEpisode: async () => ({ corrected: false, retained: false }),
        recallEpisodeCard: async () => "",
        searchEpisodeCard: async () => "",
      },
    } as unknown as CaptainDeps,
    {
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      settings: new SettingsStore(join(root, "settings.json")),
      evalSessionBoundary: {
        runtime: models,
        resources: () => createEvalResources({ systemPrompt: "You are under test.", agentsFiles: [] }),
        settings: () => createEvalSettings(),
        tools: () => ({ tools: [], customTools: [] }),
      },
    },
  );
  await captain.serveOperatorConversation({ op: "fleet", schemaVersion: 1 });

  const now = Date.now();
  const iso = (offset = 0) => new Date(now + offset).toISOString();
  const key = randomBytes(32);
  const signer = new DeviceSessionSigner(key);
  const devices = { phone: TAKE_CONTROL_GRANTS, watcher: SUPERVISE_GRANTS };
  const events = Object.entries(devices).flatMap(([deviceId, grants]) => {
    const event = (type: string, data: object) => ({
      id: randomUUID(),
      type,
      occurredAt: iso(-60_000),
      missionId: `device:${deviceId}`,
      correlationId: "lead-switch-runner",
      profileHash: "fixture",
      data: { schemaVersion: 1, deviceId, ...data },
    });
    return [
      event("device.pairing.redeemed", {
        offerId: deviceId,
        name: deviceId,
        platform: "ios",
        offeredGrants: grants,
        mintedBy: "local-operator",
        pendingExpiresAt: iso(60_000),
      }),
      event("device.activated", { grants, sessionExpiresAt: iso(60 * 60_000) }),
    ];
  });
  const eventLogPath = join(root, "devices.jsonl");
  await writeFile(eventLogPath, events.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const token = (deviceId: keyof typeof devices, ttlSeconds = 3600) =>
    signer.issue(mintDeviceSessionClaims({ deviceId, nowEpochSeconds: Math.floor(now / 1000), ttlSeconds }));
  // The service's clock, moved forward to let a phone's session expire.
  let skew = 0;
  const service = await createClankieApp({
    captain,
    deviceSessionKey: key,
    eventLogPath,
    clock: () => new Date(Date.now() + skew),
    modelKeys: { readiness: async () => ({ ready: true }) } as never,
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === `Bearer ${RELAY_BEARER}`
        ? { captainId: "relay", steerSourceLane: "api" }
        : undefined,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  const server = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const handler = createOperatorConversationRelayHandler({
    authorizeDevice: new ControlPlaneDeviceAuthorizer({ baseUrl }),
    dispatch: createCaptainConversationDispatch({ baseUrl, bearerToken: RELAY_BEARER }),
    deviceDispatch: createDeviceConversationDispatch({ baseUrl }),
  });
  const relay = createServer((request, response) => {
    void (async () => {
      if (await handler(request, response)) return;
      response.statusCode = 404;
      response.end();
    })();
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  const post = (url: string, bearer: string, body: unknown, sender?: string) =>
    fetch(new URL(OPERATOR_CONVERSATION_DISPATCH_PATH, url), {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        ...(sender === undefined ? {} : { [SENDER_DEVICE_SESSION_HEADER]: sender }),
      },
      body: JSON.stringify(body),
    });
  const revision = async () => {
    const got = await captain.serveOperatorConversation({
      op: "get",
      schemaVersion: 1,
      conversationId: LEAD,
    });
    if (got.op !== "get" || got.conversation === undefined) throw new Error("No conversation");
    return got.conversation.revision;
  };
  const send = async (url: string, bearer: string, message: string, sender?: string) => {
    const response = await post(
      url,
      bearer,
      {
        op: "send",
        schemaVersion: 1,
        turn: {
          schemaVersion: 1,
          kind: "message",
          conversationId: LEAD,
          expectedRevision: await revision(),
          message,
          surfaceClientId: "fixture",
        },
      },
      sender,
    );
    if (response.status !== 200) throw new Error(`send ${response.status} ${await response.text()}`);
    const result = OperatorConversationServiceResultSchema.parse(await response.json());
    if (result.op !== "send" || result.result.status !== "accepted") throw new Error("Send refused");
  };
  const held = async () => {
    const status = await captain.serveOperatorConversation({
      op: "lead",
      schemaVersion: 1,
      command: { action: "inbox" },
    });
    if (status.op !== "lead") throw new Error("No lead");
    return status.result.items ?? [];
  };
  const transcript = async () => readFile(join(root, "conversations", LEAD, "events.jsonl"), "utf8");

  try {
    // The owner's phone switches him off.
    expect(
      (
        await post(relayUrl, token("phone"), {
          op: "lead",
          schemaVersion: 1,
          command: { action: "set", lead: "apps" },
        })
      ).status,
    ).toBe(200);

    // His Supervise phone's message rides its own identity, and he answers it.
    await send(relayUrl, token("watcher"), "Are you there?");
    await expect.poll(transcript).toContain("Here, James.");
    expect(prompts.some((prompt) => prompt.includes("Are you there?"))).toBe(true);
    expect(await held()).toEqual([]);

    // A send on the bare captain bearer carries no owner proof: held, never run.
    await send(baseUrl, RELAY_BEARER, "Run the release script.");
    await expect
      .poll(async () => (await held()).map((item) => item.text))
      .toEqual(["Run the release script."]);
    // Nor does a sender token the service can't verify itself.
    await send(baseUrl, RELAY_BEARER, "Push to main.", `${token("watcher")}x`);
    await expect
      .poll(async () => (await held()).map((item) => item.text))
      .toEqual(["Run the release script.", "Push to main."]);

    // A worker's question is answered in its own pane: the notice is held too.
    const watches = started.mock.contexts[0] as HerdrWatchStore;
    await watches.escalateQuestion!(
      { conversationId: LEAD },
      { terminalId: "term_worker", paneId: "w1:p1" } as never,
      question,
      async () => {},
    );
    workerAsking = false;
    await captain.serveOperatorConversation(
      { op: "input_list", schemaVersion: 1 },
      {
        principal: { kind: "operator", id: "owner" },
        current: () => true,
        authorize: async () => true,
      },
    );
    await expect
      .poll(async () => (await held()).some((item) => item.text.includes("resolved elsewhere")))
      .toBe(true);
    // Only the phone's message ever reached the model.
    expect(prompts.filter((prompt) => !prompt.includes("Are you there?"))).toEqual([]);
    expect(turns).toBe(1);

    // Proof is the phone's verified session, not just its record: a message queued
    // behind a running turn is held if that session expires before it runs.
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    core.appendResponses([
      async () => {
        await released;
        return fauxAssistantMessage("Done.");
      },
    ]);
    await send(relayUrl, token("watcher"), "Hold on.");
    await expect.poll(() => prompts.some((prompt) => prompt.includes("Hold on."))).toBe(true);
    await send(relayUrl, token("watcher", 600), "Still there?");
    skew = 11 * 60_000;
    release();
    await expect.poll(async () => (await held()).map((item) => item.text)).toContain("Still there?");
    expect(prompts.some((prompt) => prompt.includes("Still there?"))).toBe(false);
    expect(turns).toBe(2);
  } finally {
    vi.restoreAllMocks();
    relay.closeAllConnections();
    relay.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
    service.close();
    await captain.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 60_000);
