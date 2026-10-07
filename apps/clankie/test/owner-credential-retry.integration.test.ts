import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "@clankie/credential-broker";
import {
  createOperatorConversationServiceClient,
  OperatorConversationServiceResultSchema,
} from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { AutonomyStore } from "../src/captain/autonomy.ts";
import { createConversationRunner } from "../src/captain/captain-conversation-runner.ts";
import type { LaneSession } from "../src/captain/captain-types.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { LaneLog } from "../src/captain/lane-log.ts";
import { BrokerCredentialStore, createRejectedCredentialRefresh } from "../src/captain/model.ts";
import {
  ownerCredentialRecoveryExtension,
  type OwnerCredentialRecovery,
} from "../src/captain/owner-credential-recovery.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";
import { TurnSettledLog } from "../src/captain/turn-metrics.ts";
import { DeliveredFileStore } from "../src/delivered-files.ts";

// Real Pi, HTTP model/token endpoints, broker and conversation journal. Pi's
// automatic retries are disabled: only the captain's credential recovery can retry.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const PROVIDER = "owner-token-fixture";
const PROMPT = "Inspect the attached image using inspect_attachment.";
const PNG = readFileSync(new URL("../../docs/site/agents/clankie-green-v1.png", import.meta.url));
interface ModelRequest {
  authorization: string | undefined;
  body: { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
}
function stream(delta: object, finish: string): string {
  const frame = (value: object, reason: string | null) =>
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
  return `${frame({ role: "assistant", ...delta }, null)}${frame({}, finish)}data: [DONE]\n\n`;
}
async function fixture(
  mode:
    | "success"
    | "refresh-failed"
    | "second-rejection"
    | "tool-before-rejection"
    | "cancel-refresh"
    | "concurrent-steer"
    | "control-handoff",
) {
  const root = await mkdtemp(join(tmpdir(), "owner-credential-retry-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let onToken = async (): Promise<void> => {};
  const tokenRequests: string[] = [];
  const modelRequests: ModelRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    if (request.url === "/token") {
      const refresh = (JSON.parse(raw) as { refresh: string }).refresh;
      tokenRequests.push(refresh);
      await onToken();
      response.setHeader("content-type", "application/json");
      if (mode === "refresh-failed") {
        response.writeHead(400);
        response.end(JSON.stringify({ error: "invalid_grant" }));
      } else
        response.end(JSON.stringify({ access: "refreshed", refresh: "next", expires: Date.now() + 3600000 }));
      return;
    }
    const body = JSON.parse(raw) as ModelRequest["body"];
    modelRequests.push({ authorization: request.headers.authorization, body });
    if (
      (request.headers.authorization !== "Bearer refreshed" &&
        !(mode === "tool-before-rejection" && modelRequests.length === 1)) ||
      mode === "second-rejection" ||
      (mode === "control-handoff" &&
        JSON.stringify(body.messages).includes("Second distinct owner turn") &&
        tokenRequests.length < 2)
    ) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "Your authentication token has expired. Please try refreshing it.",
            type: "authentication_error",
          },
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      body.messages.some((message) => message.role === "tool")
        ? stream({ content: "The image and tool result survived credential recovery." }, "stop")
        : stream(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "inspect-1",
                  type: "function",
                  function: { name: "inspect_attachment", arguments: "{}" },
                },
              ],
            },
            "tool_calls",
          ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture endpoint");
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;
  const broker = new FileCredentialStore(join(root, "credentials.json"));
  await broker.set(PROVIDER, {
    type: "oauth",
    access: "rejected",
    refresh: "r0",
    expires: Date.now() + 10 * 24 * 3600000,
  });
  const credentials = new BrokerCredentialStore(broker);
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider(PROVIDER, {
    api: "openai-completions",
    baseUrl: `${baseUrl}/v1`,
    oauth: {
      name: "Owner token fixture",
      login: async () => {
        throw new Error("Interactive login is forbidden in this fixture");
      },
      getApiKey: (current) => current.access,
      refreshToken: async (current, signal) => {
        const response = await fetch(`${baseUrl}/token`, {
          method: "POST",
          body: JSON.stringify({ refresh: current.refresh }),
          signal,
        });
        if (!response.ok) throw new Error("Refresh revoked");
        return (await response.json()) as { access: string; refresh: string; expires: number };
      },
    },
    models: [
      {
        id: "local",
        name: "Local owner fixture",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 1000,
      },
    ],
  });
  const piSettings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const control: OwnerCredentialRecovery = {};
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    systemPrompt: "Controlled owner retry fixture.",
    noExtensions: true,
    extensionFactories: [ownerCredentialRecoveryExtension(control)],
    noSkills: true,
    noPromptTemplates: true,
    settingsManager: piSettings,
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  expect(loader.getExtensions().extensions).toHaveLength(1);
  let toolCalls = 0;
  const { session } = await createAgentSession({
    cwd: root,
    model: runtime.getModel(PROVIDER, "local")!,
    thinkingLevel: "off",
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: SessionManager.create(root, join(root, "pi")),
    settingsManager: piSettings,
    noTools: "builtin",
    customTools: [
      defineTool({
        name: "inspect_attachment",
        label: "Inspect attachment",
        description: "Inspect the owner image.",
        parameters: Type.Object({}),
        execute: async () => {
          toolCalls += 1;
          return { content: [{ type: "text", text: "Image inspected." }], details: undefined };
        },
      }),
    ],
  });
  const extensionErrors: unknown[] = [];
  await session.bindExtensions({
    mode: "print",
    onError: (error) => {
      extensionErrors.push(error);
    },
  });
  const lane: LaneSession = {
    purpose: "operator",
    route: {
      current: {
        route: { purpose: "operator", tier: "work", ref: `${PROVIDER}/local` },
        selection: {
          ref: `${PROVIDER}/local`,
          model: runtime.getModel(PROVIDER, "local")!,
          thinkingLevel: "off",
        },
      },
    },
    budget: { compactBeforeNextRun: false },
    session,
    credentialRecovery: control,
    capture: {},
    quietSkills: new Set<string>(),
    lastAssistantText: "",
    turnCounter: 0,
  };
  const autonomy = new AutonomyStore(join(root, "autonomy.json"));
  const settings = new SettingsStore(join(root, "settings.json"));
  const outbox = new SeatOutbox({
    uncertaintyPath: join(root, "outbox.json"),
    onUnresolved: () => {
      throw new Error("Unexpected seat receipt");
    },
  });
  const shutdown = new AbortController();
  const recoveryCalls: string[] = [];
  const laneLog = new LaneLog(join(root, "lanes"));
  let releaseSaid!: () => void;
  let observeSaid!: () => void;
  const saidReady = new Promise<void>((resolve) => {
    observeSaid = resolve;
  });
  const saidGate = new Promise<void>((resolve) => {
    releaseSaid = resolve;
  });
  const append = laneLog.append.bind(laneLog);
  let heldSaid = false;
  laneLog.append = async (...args: Parameters<LaneLog["append"]>) => {
    await append(...args);
    if (mode === "control-handoff" && args[2].kind === "said" && !heldSaid) {
      heldSaid = true;
      observeSaid();
      await saidGate;
    }
  };
  let refreshNow = Date.now();
  const refresh = createRejectedCredentialRefresh(credentials, runtime, () => refreshNow);
  const refreshes: Promise<unknown>[] = [];
  const runner = createConversationRunner({
    shutdown,
    get conversations() {
      return conversations;
    },
    settings: () => settings.load(),
    options: { repoRoot: root, stateDir: root },
    workingDirectory: root,
    seatEventKind: () => undefined,
    seatOutbox: () => outbox,
    durableSession: async () => lane,
    buildSession: async () => {
      throw new Error("Unexpected transient session");
    },
    captureEvaluationStart: () => {},
    autonomy,
    syncModel: async () => {},
    laneLog,
    censusFleets: async () => [],
    deps: { herdrAvailable: () => false } as unknown as CaptainDeps,
    turnSettled: new TurnSettledLog(join(root, "settled.jsonl")),
    goalExecutionReason: () => undefined,
    refuseNativeGoal: () => false,
    credentialRejected: async (provider, _detail, allowRefresh = true) => {
      recoveryCalls.push(provider);
      if (!allowRefresh) return "reconnect_required";
      const pending = refresh(provider);
      refreshes.push(pending);
      return (await pending) === "refreshed" ? "refreshed" : "reconnect_required";
    },
  });
  const files = new DeliveredFileStore(join(root, "attachments"));
  const conversations = new ConversationStore(
    join(root, "conversations"),
    runner,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    root,
    {
      beginUpload: (upload) => files.beginUpload(upload),
      appendUpload: (chunk) => files.appendUpload(chunk),
      commitUpload: (id, uploadId) => files.commitUpload(id, uploadId),
      attachment: (id, artifactId) => files.attachment(id, artifactId),
    },
  );
  cleanups.push(async () => {
    shutdown.abort();
    autonomy.close();
    outbox.close();
    await conversations.close();
    await Promise.all(refreshes);
    session.dispose();
  });
  const client = createOperatorConversationServiceClient(async (request) =>
    OperatorConversationServiceResultSchema.parse(
      await conversations.serve(request as Parameters<ConversationStore["serve"]>[0]),
    ),
  );
  const id = conversations.defaultGlobalConversationId();
  const committed = await client.uploadAttachment!({
    conversationId: id,
    filename: "screen.png",
    mediaType: "image/png",
    byteCount: PNG.byteLength,
    sha256: createHash("sha256").update(PNG).digest("hex"),
    bytes: new Uint8Array(PNG),
  });
  if (committed.status !== "committed") throw new Error("Expected committed attachment");
  let resolveAccepted!: (runId: string) => void;
  const firstAccepted = new Promise<string>((resolve) => {
    resolveAccepted = resolve;
  });
  let firstResult: Promise<boolean> | undefined;
  let steeredRunId: string | undefined;
  let steeredResult: Promise<boolean> | undefined;
  onToken = async () => {
    if (mode === "control-handoff" && tokenRequests.length === 2) {
      releaseSaid();
      await firstAccepted;
      await firstResult;
      return;
    }
    if (mode !== "cancel-refresh" && mode !== "concurrent-steer") return;
    const runId = await firstAccepted;
    if (mode === "cancel-refresh") {
      await conversations.serve({ schemaVersion: 1, op: "cancel", conversationId: id, runId });
    } else {
      const steered = await client.send({
        schemaVersion: 1,
        kind: "message",
        conversationId: id,
        surfaceClientId: "second-owner-surface",
        delivery: "steer",
        expectedRevision: conversations.conversation(id)!.revision,
        message: "Also describe the image color.",
      });
      if (steered.status !== "accepted") throw new Error("Expected second accepted owner turn");
      steeredRunId = steered.runId;
      steeredResult = conversations.awaitRunResult(steered.runId);
    }
  };
  const accepted = await client.send({
    schemaVersion: 1,
    kind: "message",
    conversationId: id,
    surfaceClientId: "owner-fixture",
    expectedRevision: conversations.conversation(id)!.revision,
    message: PROMPT,
    attachments: [{ artifactId: committed.file.artifactId }],
  });
  if (accepted.status !== "accepted") throw new Error("Expected accepted owner turn");
  firstResult = conversations.awaitRunResult(accepted.runId);
  resolveAccepted(accepted.runId);
  if (mode === "control-handoff") {
    await saidReady;
    refreshNow += 60_001;
    const second = await client.send({
      schemaVersion: 1,
      kind: "message",
      conversationId: id,
      surfaceClientId: "next-owner-surface",
      delivery: "steer",
      expectedRevision: conversations.conversation(id)!.revision,
      message: "Second distinct owner turn",
    });
    if (second.status !== "accepted") throw new Error("Expected next accepted owner turn");
    steeredRunId = second.runId;
    steeredResult = conversations.awaitRunResult(second.runId);
    void steeredResult.then(() => releaseSaid());
  }
  const completed = await firstResult;
  await lane.running;
  const steeredCompleted = await steeredResult;
  expect(extensionErrors).toEqual([]);
  return {
    session,
    broker,
    steeredRunId,
    steeredCompleted,
    runId: accepted.runId,
    tokenRequests,
    modelRequests,
    recoveryCalls,
    completed,
    toolCalls,
    events: new ConversationJournal(join(root, "conversations")).read(id),
  };
}

it("refreshes once and completes the same owner turn with its image and real tool execution", async () => {
  const f = await fixture("success");
  expect(f.completed).toBe(true);
  expect(f.tokenRequests).toEqual(["r0"]);
  expect(f.recoveryCalls).toEqual([PROVIDER]);
  expect(f.modelRequests.map((request) => request.authorization)).toEqual([
    "Bearer rejected",
    "Bearer refreshed",
    "Bearer refreshed",
  ]);
  expect(f.modelRequests[1]!.body.messages).toEqual(f.modelRequests[0]!.body.messages);
  for (const request of f.modelRequests.slice(0, 2)) {
    expect(JSON.stringify(request.body.messages)).toContain("data:image/png;base64,");
    expect(request.body.tools?.map((tool) => tool.function.name)).toContain("inspect_attachment");
  }
  expect(f.toolCalls).toBe(1);
  expect(f.session.state.messages.filter((message) => message.role === "user")).toHaveLength(1);
  expect(
    f.session.state.messages.filter(
      (message) => message.role === "assistant" && message.stopReason === "error",
    ),
  ).toHaveLength(0);
  const raw = f.session.sessionManager.getEntries();
  expect(raw.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
  expect(
    raw.filter(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.stopReason === "error",
    ),
  ).toHaveLength(1);
  expect(raw.filter((entry) => entry.type === "context_edit")).toMatchObject([{ replacement: null }]);
  expect(
    f.session.sessionManager
      .buildSessionContext()
      .messages.filter((message) => message.role === "assistant" && message.stopReason === "error"),
  ).toHaveLength(0);
  expect(
    f.session.sessionManager
      .buildSessionProjection()
      .entries.flatMap((entry) => entry.messages)
      .filter((message) => message.role === "assistant" && message.stopReason === "error"),
  ).toHaveLength(0);
  expect(f.events.filter((event) => event.type === "message" && event.role === "operator")).toHaveLength(1);
  expect(f.events.filter((event) => event.type === "turn" && event.phase === "failed")).toHaveLength(0);
  expect(f.events.filter((event) => event.type === "turn" && event.phase === "completed")).toHaveLength(1);
});

it.each(["refresh-failed", "second-rejection"] as const)(
  "settles %s without another refresh or unbounded retry",
  async (mode) => {
    const f = await fixture(mode);
    expect(f.completed).toBe(false);
    expect(f.tokenRequests).toEqual(["r0"]);
    expect(f.recoveryCalls).toEqual(mode === "second-rejection" ? [PROVIDER, PROVIDER] : [PROVIDER]);
    expect(f.modelRequests.map((request) => request.authorization)).toEqual(
      mode === "refresh-failed" ? ["Bearer rejected"] : ["Bearer rejected", "Bearer refreshed"],
    );
    expect(f.toolCalls).toBe(0);
    expect(f.session.state.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(f.events.filter((event) => event.type === "message" && event.role === "operator")).toHaveLength(1);
    expect(f.events.filter((event) => event.type === "turn" && event.phase === "failed")).toHaveLength(1);
    expect(f.events.filter((event) => event.type === "turn" && event.phase === "completed")).toHaveLength(0);
  },
);

it("does not replay a tool already executed before a later model rejection", async () => {
  const f = await fixture("tool-before-rejection");
  expect(f.completed).toBe(true);
  expect(f.modelRequests.map((request) => request.authorization)).toEqual([
    "Bearer rejected",
    "Bearer rejected",
    "Bearer refreshed",
  ]);
  expect(f.tokenRequests).toEqual(["r0"]);
  expect(f.toolCalls).toBe(1);
  expect(f.modelRequests[2]!.body.messages).toEqual(f.modelRequests[1]!.body.messages);
  expect(f.session.state.messages.filter((message) => message.role === "user")).toHaveLength(1);
  expect(f.session.state.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
  expect(f.events.filter((event) => event.type === "turn" && event.phase === "failed")).toHaveLength(0);
});

it("cancellation during token refresh prevents another model request", async () => {
  const f = await fixture("cancel-refresh");
  expect(f.completed).toBe(false);
  expect(f.tokenRequests).toEqual(["r0"]);
  expect(f.modelRequests).toHaveLength(1);
  expect(f.toolCalls).toBe(0);
  expect(f.events.filter((event) => event.type === "turn" && event.phase === "completed")).toHaveLength(0);
  expect(f.events.filter((event) => event.type === "turn" && event.phase === "cancelled")).toHaveLength(1);
});

it("a concurrent owner steer shares recovery while both original receipts settle", async () => {
  const f = await fixture("concurrent-steer");
  expect(f.completed).toBe(true);
  expect(f.steeredCompleted).toBe(true);
  expect(f.steeredRunId).not.toBe(f.runId);
  expect(f.events.filter((event) => event.type === "turn" && event.phase === "completed")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ runId: f.runId, deliveryStage: "responded" }),
      expect.objectContaining({ runId: f.steeredRunId, deliveryStage: "consumed" }),
    ]),
  );
  expect(f.tokenRequests).toEqual(["r0"]);
  expect(f.recoveryCalls).toEqual([PROVIDER]);
  expect(f.session.state.messages.filter((message) => message.role === "user")).toHaveLength(2);
  expect(JSON.stringify(f.modelRequests.at(-1)!.body.messages)).toContain("Also describe the image color.");
  expect(f.events.filter((event) => event.type === "message" && event.role === "operator")).toHaveLength(2);
  expect(f.events.filter((event) => event.type === "turn" && event.phase === "failed")).toHaveLength(0);
  expect(f.events.filter((event) => event.type === "turn" && event.phase === "completed")).toHaveLength(2);
});

it("an old owner's delayed said-log cleanup cannot clear the next owner's refresh control", async () => {
  const f = await fixture("control-handoff");
  expect(f.completed).toBe(true);
  expect(f.steeredCompleted).toBe(true);
  expect(f.tokenRequests).toEqual(["r0", "next"]);
  expect(f.recoveryCalls).toEqual([PROVIDER, PROVIDER]);
  expect(f.session.state.messages.filter((message) => message.role === "user")).toHaveLength(2);
  expect(
    f.session.state.messages.filter(
      (message) => message.role === "assistant" && message.stopReason === "error",
    ),
  ).toHaveLength(0);
  expect(f.events.filter((event) => event.type === "turn" && event.phase === "failed")).toHaveLength(0);
  expect(f.events.filter((event) => event.type === "turn" && event.phase === "completed")).toHaveLength(2);
});
