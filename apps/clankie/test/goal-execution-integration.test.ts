import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { AutonomyStore } from "../src/captain/autonomy.ts";
import { enforceGoalBudget } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { laneAuthoredTools } from "../src/captain/lane-tools.ts";
import { LaneLog } from "../src/captain/lane-log.ts";
import { ConversationStore } from "../src/captain/conversations.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("retains observed native head ownership across restart and retires it only on explicit reset", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-goal-native-head-"));
  roots.push(root);
  const conversationRoot = join(root, "conversations");
  const store = new ConversationStore(conversationRoot, async () => {});
  const id = store.defaultGlobalConversationId();
  store.syncHeadTranscript("head-seat", {
    sessionKey: "native-head-transcript",
    entries: [{ type: "message", id: "entry-1", role: "agent", text: "A settled head response." }],
  });
  const path = join(conversationRoot, id, "meta.json");
  const checkpoint = JSON.parse(await readFile(path, "utf8")).seatTranscript;
  store.rememberNativeHead(id, "native-occupant-1");
  expect(store.hasNativeSeat(id)).toBe(true);
  expect(JSON.parse(await readFile(path, "utf8")).seatTranscript).toEqual(checkpoint);
  await store.close();
  const restarted = new ConversationStore(conversationRoot, async () => {});
  try {
    expect(restarted.hasNativeSeat(id)).toBe(true);
    await restarted.serve({
      schemaVersion: 1,
      op: "reset",
      conversationId: id,
      expectedRevision: restarted.conversation(id)!.revision,
    });
    expect(restarted.hasNativeSeat(id)).toBe(false);
    const current = JSON.parse(await readFile(path, "utf8"));
    expect(current.nativeSeatSessions).toEqual({ "native-occupant-1": "retired" });
  } finally {
    await restarted.close();
  }
});

/** Real Pi, provider streams, tool dispatch and durable goal state; no live credentials. */
async function fixture(
  tools: (root: string, store: AutonomyStore) => ToolDefinition[] = () => [],
  reportedUsage?: number,
) {
  const root = await mkdtemp(join(tmpdir(), "clankie-goal-execution-"));
  roots.push(root);
  const store = new AutonomyStore(join(root, "autonomy.json"));
  const core = createFauxCore({ provider: "faux-goal", api: "faux-goal", models: [{ id: "goal" }] });
  const responses: AssistantMessage[] = [];
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider("faux-goal", {
    api: "faux-goal" as Api,
    baseUrl: "http://faux.invalid",
    apiKey: "fixture",
    streamSimple: (model, context, options) => {
      const stream = core.streamSimple(model, context, options);
      void stream.result().then((message) => {
        if (reportedUsage !== undefined) message.usage = { ...message.usage, totalTokens: reportedUsage };
        responses.push(message);
      });
      return stream;
    },
    models: [
      {
        id: "goal",
        name: "Goal fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 1_000,
      },
    ],
  });
  const settings = SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false, keepRecentTokens: 100 },
  });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    systemPrompt: "Controlled integration fixture.",
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    settingsManager: settings,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: root,
    model: runtime.getModel("faux-goal", "goal")!,
    thinkingLevel: "off",
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root),
    settingsManager: settings,
    noTools: "builtin",
    customTools: tools(root, store),
  });
  await session.bindExtensions({ mode: "print" });
  return { root, store, session, core, responses };
}

it("a real Pi model proposes an inert persisted goal until an owner accepts it", async () => {
  const f = await fixture((root, store) =>
    laneAuthoredTools(
      {
        memory: {},
        embodiment: {
          submitIntent: async () => {
            throw new Error("Unused fixture body");
          },
          getSession: async () => {
            throw new Error("Unused fixture body");
          },
          getLiveSession: async () => {
            throw new Error("Unused fixture body");
          },
        },
      } as unknown as CaptainDeps,
      { targetId: "global-default", shell: true },
      new LaneLog(join(root, "lanes")),
      "operator",
      undefined,
      store,
    ),
  );
  let continuations = 0;
  f.store.start(async () => {
    continuations += 1;
  });
  try {
    f.core.setResponses([
      fauxAssistantMessage(fauxToolCall("create_goal", { objective: "Check the controlled fixture" })),
      fauxAssistantMessage("The objective and budget are ready for the owner to accept."),
    ]);
    await f.session.prompt("Propose a durable goal for the fixture.");
    expect(f.store.getGoal("global-default")).toMatchObject({
      objective: "Check the controlled fixture",
      status: "proposed",
      tokenBudget: 1_000_000,
      tokensUsed: 0,
    });
    expect(continuations).toBe(0);
    const restarted = new AutonomyStore(join(f.root, "autonomy.json"));
    expect(restarted.getGoal("global-default")?.status).toBe("proposed");
    f.store.command("global-default", { action: "set_enabled", enabled: false });
    f.store.command("global-default", { action: "accept_goal" });
    expect(f.store.getGoal("global-default")?.status).toBe("active");
    expect(continuations).toBe(0);
  } finally {
    f.store.close();
    f.session.dispose();
  }
});

it.each(["complete", "blocked"] as const)(
  "a %s status cannot bypass the captured run's numerical budget",
  async (status) => {
    const f = await fixture((_root, store) => [
      defineTool({
        name: "settle",
        label: "Settle",
        description: "Settle the captured fixture goal.",
        parameters: Type.Object({}),
        execute: async () => {
          store.updateGoal("global-default", status);
          return { content: [{ type: "text", text: "Settled." }], details: undefined };
        },
      }),
      defineTool({
        name: "step",
        label: "Step",
        description: "Continue the fixture.",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "A step." }], details: undefined }),
      }),
    ]);
    const goal = f.store.createGoal("global-default", "Verify numerical cap", 500);
    const release = enforceGoalBudget(f.session, f.store, "global-default", goal, true);
    try {
      f.core.setResponses([
        fauxAssistantMessage(fauxToolCall("settle", {})),
        ...Array.from({ length: 20 }, (_, i) =>
          fauxAssistantMessage(fauxToolCall("step", {}, { id: `after-${i}` })),
        ),
      ]);
      await f.session.prompt("Run the controlled terminal-state loop.");
      expect(goal.status).toBe(status);
      expect(goal.tokensUsed).toBeGreaterThanOrEqual(goal.tokenBudget!);
      expect(f.core.state.callCount).toBeLessThan(21);
      const calls = f.core.state.callCount;
      await f.session.prompt("A further request cannot escape the cap.");
      expect(f.core.state.callCount).toBe(calls);
    } finally {
      release();
      f.session.dispose();
    }
  },
);

it.each(
  [0, Number.NaN, 0.5, Number.MAX_SAFE_INTEGER + 1].flatMap((usage) =>
    [true, false].map((autonomous) => ({ usage, autonomous })),
  ),
)(
  "unaccountable provider usage ($usage, autonomous=$autonomous) stops captured goal requests",
  async ({ usage, autonomous }) => {
    const f = await fixture(() => [], usage);
    const goal = f.store.createGoal("global-default", "Bound missing provider usage", 1_000_000);
    const release = enforceGoalBudget(f.session, f.store, "global-default", goal, autonomous);
    try {
      f.core.setResponses([fauxAssistantMessage("A response without usable usage")]);
      await f.session.prompt("Request the unaccountable response.");
      expect(goal.status).toBe("usage_limited");
      expect(goal.tokensUsed).toBe(0);
      const calls = f.core.state.callCount;
      await f.session.prompt("Cannot request another response.");
      expect(f.core.state.callCount).toBe(calls);
      expect(new AutonomyStore(join(f.root, "autonomy.json")).getGoal("global-default")?.status).toBe(
        "usage_limited",
      );
    } finally {
      release();
      f.session.dispose();
    }
  },
);

it("counts manual compaction provider usage and blocks later calls after it exhausts a goal", async () => {
  const f = await fixture();
  try {
    f.core.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage("Recorded earlier turn.")));
    for (let i = 0; i < 6; i++) await f.session.prompt(`Earlier turn ${i}: ${"x".repeat(500)}`);
    const goal = f.store.createGoal("global-default", "Budget summarization too", 1);
    const release = enforceGoalBudget(f.session, f.store, "global-default", goal, true);
    try {
      const priorCalls = f.core.state.callCount;
      f.core.setResponses([fauxAssistantMessage("A compacted summary of the earlier turns.")]);
      await expect(f.session.compact()).rejects.toThrow("Compaction cancelled");
      expect(f.core.state.callCount).toBeGreaterThan(priorCalls);
      expect(goal.status).toBe("budget_limited");
      expect(goal.tokensUsed).toBe(
        f.responses.slice(priorCalls).reduce((sum, response) => sum + response.usage.totalTokens, 0),
      );
      const calls = f.core.state.callCount;
      await f.session.prompt("Try after compaction exhausted the goal.");
      expect(f.core.state.callCount).toBe(calls);
    } finally {
      release();
    }
  } finally {
    f.session.dispose();
  }
});

it("stops a real Pi tool loop at the default budget and persists each response's usage once", async () => {
  const f = await fixture(
    (root) => [
      defineTool({
        name: "step",
        label: "Step",
        description: "Append a real fixture step.",
        parameters: Type.Object({}),
        execute: async () => {
          const path = join(root, "steps.txt");
          const before = await readFile(path, "utf8").catch(() => "");
          await writeFile(path, `${before}step\n`);
          return { content: [{ type: "text", text: "Fixture step recorded." }], details: undefined };
        },
      }),
    ],
    400_000,
  );
  const goal = f.store.createGoal("global-default", "Complete the fixture loop");
  expect(goal.tokenBudget).toBe(1_000_000);
  const release = enforceGoalBudget(f.session, f.store, "global-default", goal, true);
  try {
    f.core.setResponses(
      Array.from({ length: 20 }, (_, i) =>
        fauxAssistantMessage(fauxToolCall("step", {}, { id: `step-${i}` })),
      ),
    );
    await f.session.prompt("Continue the fixture loop.");
    expect(f.core.state.callCount).toBeGreaterThan(1);
    expect(f.core.state.callCount).toBeLessThan(20);
    expect(goal.status).toBe("budget_limited");
    expect(goal.tokensUsed).toBe(f.responses.reduce((sum, response) => sum + response.usage.totalTokens, 0));
    expect(goal.tokensUsed).toBeGreaterThanOrEqual(goal.tokenBudget!);
    const callsAtLimit = f.core.state.callCount;
    await f.session.prompt("Try another continuation.");
    expect(f.core.state.callCount).toBe(callsAtLimit);
    expect(new AutonomyStore(join(f.root, "autonomy.json")).getGoal("global-default")).toMatchObject({
      status: "budget_limited",
      tokensUsed: goal.tokensUsed,
    });
  } finally {
    release();
    f.session.dispose();
  }
});

it("charges a failed provider response before its turn fails", async () => {
  const f = await fixture();
  const goal = f.store.createGoal("global-default", "Observe provider failure", 1_000_000);
  const release = enforceGoalBudget(f.session, f.store, "global-default", goal, true);
  try {
    f.core.setResponses([
      fauxAssistantMessage("partial response before failure", {
        stopReason: "error",
        errorMessage: "Controlled provider failure",
      }),
    ]);
    await f.session.prompt("Run the controlled failure.");
    expect(f.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
    expect(goal.tokensUsed).toBeGreaterThan(0);
    expect(goal.tokensUsed).toBe(f.responses[0]!.usage.totalTokens);
    expect(new AutonomyStore(join(f.root, "autonomy.json")).getGoal("global-default")?.tokensUsed).toBe(
      goal.tokensUsed,
    );
  } finally {
    release();
    f.session.dispose();
  }
});

it.each([true, false])(
  "cannot charge or continue an in-flight replaced goal (autonomous=%s)",
  async (autonomous) => {
    const f = await fixture();
    const original = f.store.createGoal("global-default", "Old goal", 500);
    const release = enforceGoalBudget(f.session, f.store, "global-default", original, autonomous);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let respond!: (response: AssistantMessage) => void;
    const response = new Promise<AssistantMessage>((resolve) => {
      respond = resolve;
    });
    try {
      f.core.setResponses([
        (() => {
          entered();
          return response;
        }) satisfies FauxResponseStep,
      ]);
      const running = f.session.prompt("Run the old goal.");
      await started;
      f.store.command("global-default", { action: "clear_goal" });
      const replacement = f.store.createGoal("global-default", "Replacement goal", 500);
      respond(fauxAssistantMessage("The old request settled."));
      await running;
      expect(replacement.tokensUsed).toBe(0);
      const calls = f.core.state.callCount;
      await f.session.prompt("Try stale continuation.");
      expect(f.core.state.callCount).toBe(calls);
      expect(replacement.tokensUsed).toBe(0);
    } finally {
      release();
      f.session.dispose();
    }
  },
);

it("an owner pause during asynchronous request preparation reaches no real provider", async () => {
  const f = await fixture();
  const goal = f.store.createGoal("global-default", "Wait for controlled preparation", 500);
  const original = f.session.agent.prepareRequest;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.session.agent.prepareRequest = async (request, signal) => {
    entered();
    await gate;
    return (await original?.(request, signal)) ?? undefined;
  };
  const release = enforceGoalBudget(f.session, f.store, "global-default", goal, true);
  try {
    f.core.setResponses([fauxAssistantMessage("This response must never be requested.")]);
    const running = f.session.prompt("Prepare the queued goal.");
    await started;
    f.store.pauseGoal("global-default", goal);
    finish();
    await running;
    expect(goal.status).toBe("paused");
    expect(goal.tokensUsed).toBe(0);
    expect(f.core.state.callCount).toBe(0);
    expect(f.core.getPendingResponseCount()).toBe(1);
    expect(new AutonomyStore(join(f.root, "autonomy.json")).getGoal("global-default")?.status).toBe("paused");
  } finally {
    finish();
    release();
    f.session.dispose();
  }
});
