import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { AutonomyStore } from "../src/captain/autonomy.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import { HerdrWatchStore, type HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";
import * as fleetRunner from "../src/captain/herdr-fleet-runner.ts";

const fake = vi.hoisted(() => ({
  prompts: [] as string[],
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
    const listeners = new Set<(event: unknown) => void>();
    return {
      session: {
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
        dispose: () => {},
        prompt: async (text: string) => {
          fake.prompts.push(text);
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
        },
      },
    };
  },
  DefaultResourceLoader: class {
    async reload() {}
    getSkills() {
      return { skills: [] };
    }
  },
}));
vi.mock("../src/captain/lane-tools.ts", () => ({
  laneAuthoredTools: () => [],
  buildLaneToolBank: () => ({ lane: "operator", tools: [] }),
}));

const fixtures: { captain: ReturnType<typeof createCaptain>; root: string }[] = [];
afterEach(async () => {
  for (const { captain, root } of fixtures.splice(0)) {
    await captain.close();
    rmSync(root, { recursive: true, force: true });
  }
  fake.prompts.length = 0;
  fake.beforePrompt = async () => {};
  vi.restoreAllMocks();
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "captain-conversation-driver-"));
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
  });
  fixtures.push({ captain, root });
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
    return captain.serveOperatorConversation({
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId: id,
        surfaceClientId: "app",
        expectedRevision: got.conversation.revision,
        message,
        delivery: "queue",
      },
    });
  };
  return { captain, id, journal, send, agent, autonomous, root };
}

it("the attached project receives worker reports, watches, self wakes and escalations without Pi or global leakage", async () => {
  const { captain, id, journal, send, agent, autonomous } = await fixture();
  const globalAbort = new AbortController();
  const global = captain.pollSeatEvents(10_000, globalAbort.signal);
  let poll = captain.pollSeatEvents(10_000, undefined, id);
  const binding = (await captain.fleetSeatMessageBinding(agent.paneId))!;
  const delivery = { id: randomUUID(), binding };
  expect(await captain.receiveFleetSeatMessage(agent.paneId, "Completed the work", delivery)).toMatchObject({
    received: true,
    deliveryStage: "stored",
  });
  const [worker] = await poll;
  expect(worker).toMatchObject({
    kind: "watch",
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
  poll = captain.pollSeatEvents(10_000, undefined, id);
  expect(await send("Owner asks the attached seat")).toMatchObject({
    op: "send",
    result: { status: "accepted" },
  });
  const [escalation] = await poll;
  expect(escalation).toMatchObject({ kind: "escalation", conversationId: id });
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
  await send("Resume after the seat left");
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

it("a followed owned Linear notification reaches the attached project exactly once across a provider retry", async () => {
  const { captain, id, root } = await fixture();
  await new SettingsStore(join(root, "settings.json")).update((value) => ({
    ...value,
    linearWebhook: { ...value.linearWebhook, following: true },
  }));
  const organizationId = randomUUID();
  const issueId = randomUUID();
  expect(captain.recordLinearWorkOwner({ organizationId, issueId }, { conversationId: id })).toBe(true);
  const poll = captain.pollSeatEvents(10000, undefined, id);
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
  expect(captain.receiveLinearActivity(activity, true)).toBe(true);
  const [event] = await poll;
  expect(event).toMatchObject({
    kind: "wake",
    conversationId: id,
    content: expect.stringContaining("Review the issue"),
  });
  expect(fake.prompts).toEqual([]);
  await captain.acknowledgeSeatEvent(event!.id, id);
  expect(captain.receiveLinearActivity(activity, true)).toBe(false);
  expect(await captain.pollSeatEvents(0, undefined, id)).toEqual([]);
  expect(fake.prompts).toEqual([]);
});
