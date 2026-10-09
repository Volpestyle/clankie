import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { OperatorSeatEventKindSchema } from "@clankie/protocol";
import { createCaptain } from "../src/captain/captain.ts";
import { createClankieApp } from "../src/app.ts";
import {
  createCaptainOperatorConversationClient,
  createCaptainRouteClient,
} from "../../tui/src/session/operator-conversations.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { AutonomyStore } from "../src/captain/autonomy.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import { CONVERSATION_RUN_STALL_MS } from "../src/captain/conversation-run.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { QuestionDraftSchema } from "../src/captain/conversation-questions.ts";
import { HerdrWatchStore, type HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";
import * as fleetRunner from "../src/captain/herdr-fleet-runner.ts";

const fake = vi.hoisted(() => ({
  prompts: [] as string[],
  beforeCreate: vi.fn(async () => {}),
  dispose: vi.fn(() => {}),
  emit: (_event: unknown) => {},
  beforePrompt: async (_text: string) => {},
}));
vi.mock("../src/captain/model.ts", () => ({
  createCaptainModelRuntime: async () => ({
    runtime: {},
    resolveRoute: async () => ({
      selection: { model: { id: "fake", provider: "fake", contextWindow: 1000 }, thinkingLevel: "off" },
    }),
  }),
}));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
  createAgentSession: async () => {
    await fake.beforeCreate();
    const listeners = new Set<(event: unknown) => void>();
    fake.emit = (event) => {
      for (const listener of listeners) listener(event);
    };
    const session = {
      isStreaming: false,
      state: { messages: [] },
      model: { id: "fake", provider: "fake", contextWindow: 1000 },
      thinkingLevel: "off",
      bindExtensions: async () => {},
      subscribe: (listener: (event: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getContextUsage: () => undefined,
      resourceLoader: { getSkills: () => ({ skills: [] }) },
      abort: async () => {},
      dispose: fake.dispose,
      prompt: async (text: string) => {
        fake.prompts.push(text);
        session.isStreaming = true;
        for (const listener of listeners) listener({ type: "agent_start" });
        try {
          await fake.beforePrompt(text);
          for (const listener of listeners)
            listener({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Service answer" }],
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
              },
            });
        } finally {
          session.isStreaming = false;
        }
      },
    };
    return { session };
  },
  DefaultResourceLoader: class {
    async reload() {}
    getExtensions() {
      return { extensions: [] };
    }
    getSkills() {
      return { skills: [] };
    }
  },
}));
vi.mock("../src/captain/lane-tools.ts", () => ({
  laneAuthoredTools: () => [],
  buildLaneToolBank: () => ({ lane: "operator", tools: [] }),
}));

const fixtures: { captain: ReturnType<typeof createCaptain>; root: string; closeService: () => void }[] = [];
afterEach(async () => {
  for (const { captain, root, closeService } of fixtures.splice(0)) {
    closeService();
    await captain.close();
    rmSync(root, { recursive: true, force: true });
  }
  fake.prompts.length = 0;
  fake.beforeCreate.mockReset();
  fake.dispose.mockClear();
  fake.emit = () => {};
  fake.beforePrompt = async () => {};
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture(pendingOwnerAction = false) {
  const root = mkdtempSync(join(tmpdir(), "captain-conversation-driver-"));
  if (pendingOwnerAction) {
    const store = new ConversationStore(join(root, "conversations"), async () => {});
    await store.requestSurfaceQuestion(
      "global-default",
      QuestionDraftSchema.parse({
        purpose: "owner_action",
        kind: "text",
        prompt: "Run diagnostics?",
        waitingOn: "Root-cause evidence",
        steps: ["Run the read-only diagnostics"],
      }),
      { current: () => true },
    );
    await store.close();
  }
  const agent: HerdrAgentSnapshot = {
    paneId: "w1:p1",
    terminalId: "worker-seat",
    agent: "codex",
    status: "idle",
    title: "Worker",
    session: { source: "herdr:codex", kind: "id", value: "native-worker" },
  };
  const get = async () => agent;
  vi.spyOn(fleetRunner, "routeHerdrFleets").mockReturnValue({ get, wait: get, resolveTerminal: get });
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  let autonomous!: Parameters<AutonomyStore["start"]>[0];
  vi.spyOn(AutonomyStore.prototype, "start").mockImplementation((run) => {
    autonomous = run;
  });
  const captain = createCaptain({ memory: {} } as CaptainDeps, {
    repoRoot: root,
    stateDir: root,
    workingDirectory: root,
    settings: new SettingsStore(join(root, "settings.json")),
    personaImages: async () => ({ images: [], hash: "fake", files: [] }),
    nativeCensusRunner: async (_command, args) => {
      // Use the same current native identity as agent/get. A stored worker
      // report needs fresh census proof, not an empty display-only fixture.
      const row = {
        pane_id: agent.paneId,
        terminal_id: agent.terminalId,
        agent: agent.agent,
        agent_status: agent.status,
        title: agent.title,
        agent_session: agent.session,
      };
      let result: unknown;
      if (args[0] === "agent" && args[1] === "list") result = { agents: [row] };
      else if (args[0] === "agent" && args[1] === "get") result = { agent: row };
      else if (args[0] === "pane" && args[1] === "list") result = { panes: [row] };
      else if (args[0] === "workspace" && args[1] === "list") result = { workspaces: [] };
      else if (args[0] === "api" && args[1] === "snapshot")
        result = { snapshot: { agents: [row], panes: [row], workspaces: [], tabs: [] } };
      else throw new Error(`Unexpected external Herdr command: ${args.join(" ")}`);
      return { stdout: JSON.stringify({ result }), stderr: "" };
    },
  });
  const service = await createClankieApp({
    captain,
    settings: new SettingsStore(join(root, "settings.json")),
    eventLogPath: join(root, "events.jsonl"),
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-captain"
        ? { captainId: "fixture", steerSourceLane: "api" }
        : undefined,
  });
  fixtures.push({ captain, root, closeService: service.close });
  const fetchImpl: typeof fetch = async (input, init) => service.app.fetch(new Request(input, init));
  const client = createCaptainOperatorConversationClient(
    createCaptainRouteClient({ host: "http://fixture", captainToken: "fixture-captain", fetchImpl }),
  );
  const created = await captain.serveOperatorConversation({
    op: "create",
    schemaVersion: 1,
    scope: { kind: "workspace", workspaceId: root },
    title: "Leading project",
  });
  if (created.op !== "create") throw new Error("conversation missing");
  const id = created.conversation.conversationId;
  vi.spyOn(HerdrWatchStore.prototype, "nativeOwner").mockReturnValue({ conversationId: id });
  const journal = new ConversationJournal(join(root, "conversations"));
  const send = async (message: string) => {
    const got = await captain.serveOperatorConversation({ op: "get", schemaVersion: 1, conversationId: id });
    if (got.op !== "get" || got.conversation === undefined) throw new Error("conversation missing");
    // Production serialization, authenticated HTTP dispatch, host admission
    // and public response parsing all participate in the watchdog fixture.
    return {
      op: "send" as const,
      schemaVersion: 1 as const,
      result: await client.send({
        schemaVersion: 1,
        kind: "message",
        conversationId: id,
        surfaceClientId: "app",
        expectedRevision: got.conversation.revision,
        message,
        delivery: "queue",
      }),
    };
  };
  const settleSeat = () =>
    expect(
      captain.syncSeatTranscript(id, {
        sessionId: "fixture-operator-session",
        entries: [],
        activity: "waiting",
      }),
    ).toBe(true);
  return { captain, id, journal, send, agent, autonomous, root, settleSeat };
}

it("a stuck session startup fails loudly and releases an attached seat to handle later turns", async () => {
  const { captain, id, journal, send, agent, settleSeat } = await fixture();
  let entered!: () => void;
  const starting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fake.beforeCreate.mockImplementationOnce(async () => {
    entered();
    await gate;
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers();
  const delivery = { id: randomUUID(), binding: (await captain.fleetSeatMessageBinding(agent.paneId))! };
  let poll: ReturnType<typeof captain.pollSeatEvents> | undefined;
  try {
    expect(
      await captain.receiveFleetSeatMessage(agent.paneId, "Original worker report", delivery),
    ).toMatchObject({ received: true, deliveryStage: "stored" });
    await starting;
    const first = journal.read(id).find((event) => event.type === "turn" && event.phase === "accepted")!;
    if (first.type !== "turn") throw new Error("acceptance missing");
    poll = captain.pollSeatEvents(10_000, undefined, id);
    void poll.catch(() => {});
    for (let i = 0; i < 9; i++) await send(`Later owner turn ${i}`);
    expect(fake.prompts).toEqual([]);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect(journal.read(id)).toContainEqual(
      expect.objectContaining({
        type: "turn",
        runId: first.runId,
        phase: "failed",
        reasonCode: "conversation_turn_stalled",
      }),
    );
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(first.runId), expect.any(Error));
    for (let i = 0; i < 9; i++) {
      const [event] = await poll;
      expect(event?.content).toContain(`Later owner turn ${i}`);
      poll = captain.pollSeatEvents(10_000, undefined, id);
      void poll.catch(() => {});
      await captain.replySeatEvent(event!.id, "Native answer", id);
      settleSeat();
    }
    // Reconciliation preserves the original acceptance; it never replays the report.
    expect(
      await captain.receiveFleetSeatMessage(agent.paneId, "Original worker report", delivery),
    ).toMatchObject({ received: true });
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.prompts).toEqual([]);
    expect(fake.dispose).toHaveBeenCalledOnce();
  } finally {
    release();
    await captain.close();
    await poll?.catch(() => {});
  }
});

it.each(["startup", "execution"])(
  "a stuck %s is evicted so later service turns proceed before its late rejection",
  async (boundary) => {
    const { captain, id, journal, send } = await fixture();
    let entered!: () => void;
    const starting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let reject!: (error: Error) => void;
    const gate = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    if (boundary === "startup")
      fake.beforeCreate.mockImplementationOnce(async () => {
        entered();
        await gate;
      });
    else
      fake.beforePrompt = async (text) => {
        if (text.includes("Hung execution")) {
          entered();
          await gate;
        }
      };
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      // The HTTP receipt waits for real start/admission; cold startup is the
      // dependency this test deliberately leaves unresolved.
      const receipt = send(`Hung ${boundary}`);
      await starting;
      await send("Later service turn");
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      await receipt;
      await vi.waitFor(() =>
        expect(
          journal.read(id).filter((event) => event.type === "turn" && event.phase === "completed"),
        ).toHaveLength(1),
      );
      const failed = journal.read(id).find((event) => event.type === "turn" && event.phase === "failed");
      expect(failed).toMatchObject({ reasonCode: "conversation_turn_stalled" });
      expect(fake.prompts.some((text) => text.includes("Later service turn"))).toBe(true);
      expect(fake.beforeCreate).toHaveBeenCalledTimes(2);
      reject(new Error("Late abandoned dependency rejection"));
      await vi.advanceTimersByTimeAsync(1);
      await send("Reuse the healthy replacement session");
      await vi.waitFor(() =>
        expect(
          journal.read(id).filter((event) => event.type === "turn" && event.phase === "completed"),
        ).toHaveLength(2),
      );
      expect(fake.beforeCreate).toHaveBeenCalledTimes(2);
      expect(fake.prompts.filter((text) => text.includes(`Hung ${boundary}`))).toHaveLength(
        boundary === "startup" ? 0 : 1,
      );
    } finally {
      reject(new Error("Release fixture"));
      await captain.close();
    }
  },
);

it("Pi progress keeps an operator turn alive beyond the inactivity deadline", async () => {
  const { captain, id, journal, send } = await fixture();
  let entered!: () => void;
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fake.beforePrompt = async () => {
    entered();
    await gate;
  };
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers();
  try {
    await send("Healthy long-running work");
    await running;
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      fake.emit({ type: "agent_start" });
    }
    expect(journal.read(id).filter((event) => event.type === "turn" && event.phase !== "accepted")).toEqual(
      [],
    );
    release();
    await vi.waitFor(() =>
      expect(journal.read(id)).toContainEqual(expect.objectContaining({ type: "turn", phase: "completed" })),
    );
    expect(errors).not.toHaveBeenCalled();
  } finally {
    release();
    await captain.close();
  }
});

it("a silent in-flight tool keeps an operator turn alive beyond the inactivity deadline", async () => {
  const { captain, id, journal, send } = await fixture();
  let entered!: () => void;
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fake.beforePrompt = async () => {
    entered();
    await gate;
  };
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers();
  try {
    await send("Run a long check with output redirected");
    await running;
    fake.emit({
      type: "tool_execution_start",
      toolCallId: "silent-check",
      toolName: "bash",
      args: { command: "pnpm check > log 2>&1" },
    });
    await vi.advanceTimersByTimeAsync(CONVERSATION_RUN_STALL_MS + 8 * 60_000);
    expect(journal.read(id).filter((event) => event.type === "turn" && event.phase !== "accepted")).toEqual(
      [],
    );
    expect(fake.dispose).not.toHaveBeenCalled();
    fake.emit({
      type: "tool_execution_end",
      toolCallId: "silent-check",
      toolName: "bash",
      result: { content: [], details: {} },
      isError: false,
    });
    release();
    await vi.waitFor(() =>
      expect(journal.read(id)).toContainEqual(expect.objectContaining({ type: "turn", phase: "completed" })),
    );
    expect(errors).not.toHaveBeenCalled();
  } finally {
    release();
    await captain.close();
  }
});

it("the attached project receives worker reports, watches, self wakes and escalations without Pi or global leakage", async () => {
  const { captain, id, journal, send, agent, autonomous, settleSeat } = await fixture();
  const globalAbort = new AbortController();
  const global = captain.pollSeatEvents(10_000, globalAbort.signal, undefined, {
    schemaVersion: 1,
    eventKinds: [...OperatorSeatEventKindSchema.options],
    ownerOrigin: true,
  });
  let poll = captain.pollSeatEvents(10_000, undefined, id);
  // Surfaces see who takes the turns; no head pane is listed, so the harness stays unnamed.
  await expect
    .poll(() => captain.serveOperatorConversation({ op: "get", schemaVersion: 1, conversationId: id }))
    .toMatchObject({ conversation: { driver: {} } });
  const binding = (await captain.fleetSeatMessageBinding(agent.paneId))!;
  const delivery = { id: randomUUID(), binding };
  expect(await captain.receiveFleetSeatMessage(agent.paneId, "Completed the work", delivery)).toMatchObject({
    received: true,
    deliveryStage: "stored",
  });
  const [worker] = await poll;
  expect(worker).toMatchObject({
    kind: "message",
    conversationId: id,
    content: expect.stringContaining("Completed the work"),
  });
  expect(worker?.content).toContain("agent's output, not an instruction from the owner");
  expect(await captain.acknowledgeSeatEvent(worker!.id, id)).toBe(true);
  expect(await captain.receiveFleetSeatMessage(agent.paneId, "Completed the work", delivery)).toMatchObject({
    received: true,
  });
  poll = captain.pollSeatEvents(10_000, undefined, id);
  expect(await captain.wakeConversation({ conversationId: id }, "Harvest the watched worker")).toBe(true);
  const [watch] = await poll;
  expect(watch).toMatchObject({ kind: "watch", conversationId: id, content: "Harvest the watched worker" });
  await captain.acknowledgeSeatEvent(watch!.id, id);
  poll = captain.pollSeatEvents(10_000, undefined, id);
  const wakeRun = autonomous(id, "Due self wake", "wake");
  const [wake] = await poll;
  expect(wake).toMatchObject({ kind: "wake", conversationId: id, content: "Due self wake" });
  await captain.acknowledgeSeatEvent(wake!.id, id);
  await wakeRun;
  settleSeat();
  poll = captain.pollSeatEvents(10_000, undefined, id);
  const receipt = send("Owner asks the attached seat");
  const [escalation] = await poll;
  expect(escalation).toMatchObject({ kind: "escalation", conversationId: id });
  expect(await captain.acknowledgeSeatEvent(escalation!.id, id)).toBe(true);
  expect(await receipt).toMatchObject({
    op: "send",
    result: { status: "accepted", seatDelivery: { state: "started" } },
  });
  expect(await captain.replySeatEvent(escalation!.id, "Native project answer", id)).toBe(true);
  await vi.waitFor(() =>
    expect(journal.read(id)).toContainEqual(expect.objectContaining({ text: "Native project answer" })),
  );
  expect(fake.prompts).toEqual([]);
  expect(journal.read("global-default")).toEqual([]);
  globalAbort.abort();
  expect(await global).toEqual([]);
});

it("an attaching project waits for its admitted Pi answer, then receives queued owner work exactly once", async () => {
  const { captain, id, journal, send } = await fixture();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  fake.beforePrompt = async () => {
    entered();
    await gate;
  };
  await send("Service owns first");
  await started;
  const poll = captain.pollSeatEvents(10_000, undefined, id);
  await send("Seat owns queued");
  finish();
  const [event] = await poll;
  expect(event).toMatchObject({ kind: "escalation", conversationId: id, content: "Seat owns queued" });
  await captain.replySeatEvent(event!.id, "Native queued answer", id);
  await vi.waitFor(() =>
    expect(
      journal.read(id).filter((entry) => entry.type === "turn" && entry.phase === "completed"),
    ).toHaveLength(2),
  );
  expect(fake.prompts).toHaveLength(1);
  expect(fake.prompts[0]).toContain("Service owns first");
  expect(
    journal.read(id).filter((entry) => entry.type === "message" && entry.role === "captain"),
  ).toMatchObject([{ text: "Service answer" }, { text: "Native queued answer" }]);
});

it("a definite native refusal resumes the project service runner once", async () => {
  const { captain, id, journal, send } = await fixture();
  // Establish then leave a poll within its grace without taking the send.
  expect(await captain.pollSeatEvents(1, undefined, id)).toEqual([]);
  expect(await send("Resume after the seat left")).toMatchObject({
    op: "send",
    result: { status: "accepted", deliveryStage: "delivered", seatDelivery: { state: "started" } },
  });
  await vi.waitFor(
    () =>
      expect(
        journal.read(id).filter((entry) => entry.type === "turn" && entry.phase === "completed"),
      ).toHaveLength(1),
    { timeout: 5_000 },
  );
  expect(fake.prompts).toHaveLength(1);
  expect(fake.prompts[0]).toContain("Resume after the seat left");
  expect(await captain.pollSeatEvents(0, undefined, id)).toEqual([]);
});

it("a Linear event reaches the selected ordinary chat driver exactly once across a provider retry", async () => {
  const { captain, id, root } = await fixture();
  await new SettingsStore(join(root, "settings.json")).update((value) => ({
    ...value,
    linearWebhook: { ...value.linearWebhook, following: true },
  }));
  const organizationId = randomUUID();
  const issueId = randomUUID();
  const created = await captain.serveOperatorConversation({
    op: "create",
    schemaVersion: 1,
    scope: { kind: "global" },
    title: "Linear",
  });
  if (created.op !== "create") throw new Error("Create failed");
  const target = created.conversation.conversationId;
  const poll = captain.pollSeatEvents(10000, undefined, target);
  const activity = {
    eventId: "1".repeat(64),
    notification: true,
    issueId,
    organizationId,
    deliveryId: undefined,
    type: "Notification",
    action: "issueNewComment",
    actorName: "James",
    actorEmail: undefined,
    createdAt: new Date().toISOString(),
    url: undefined,
    data: { title: "Review the issue" },
    updatedFrom: undefined,
  };
  expect(captain.receiveLinearActivity(activity, true, target)).toBe(true);
  const [event] = await poll;
  expect(event).toMatchObject({
    kind: "wake",
    conversationId: target,
    content: expect.stringContaining("Review the issue"),
  });
  expect(fake.prompts).toEqual([]);
  await captain.acknowledgeSeatEvent(event!.id, target);
  expect(captain.receiveLinearActivity(activity, true, target)).toBe(false);
  expect(await captain.pollSeatEvents(0, undefined, id)).toEqual([]);
  expect(fake.prompts).toEqual([]);
});

it("native seat polling leaves an unanswered owner action pending with no resolution event", async () => {
  const { captain, root } = await fixture(true);
  const path = join(root, "conversations", "global-default", "meta.json");
  const before = JSON.parse(readFileSync(path, "utf8")).questions.records[0].question;
  expect(before.status).toBe("pending");
  await captain.pollSeatEvents(0, undefined, "global-default");
  await captain.pollSeatEvents(0, undefined, "global-default");
  expect(JSON.parse(readFileSync(path, "utf8")).questions.records[0].question).toEqual(before);
  expect(readFileSync(join(root, "conversations", "global-default", "events.jsonl"), "utf8")).not.toContain(
    '"type":"input_resolved"',
  );
});
