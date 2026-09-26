import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiModelSelection } from "@clankie/model-provider";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  InMemoryCredentialStore,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { RoutedSelection } from "../src/captain/model.ts";
import {
  captainRoutingExtension,
  ESCALATE_TOOL_NAME,
  type EscalationRecord,
} from "../src/captain/routing.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A real Pi session over a scripted provider: proves the escalation seam the
 * routing extension depends on — a model set mid-run is the model of the next
 * call in the same run, with no replayed prompt.
 */
async function piSession(route: (models: { routine: Model<Api>; work: Model<Api> }) => RoutedSelection) {
  const dir = await mkdtemp(join(tmpdir(), "clankie-routing-pi-"));
  dirs.push(dir);
  const core = createFauxCore({
    provider: "faux",
    api: "faux-routing",
    models: [{ id: "routine-model" }, { id: "work-model" }],
  });
  const calls: string[] = [];
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider("faux", {
    api: "faux-routing" as Api,
    baseUrl: "http://faux.invalid",
    apiKey: "faux",
    streamSimple: (model, context, options) => {
      calls.push(model.id);
      return core.streamSimple(model, context, options);
    },
    models: core.models.map((model) => ({
      id: model.id,
      name: model.id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 1_000,
    })),
  });
  const models = {
    routine: runtime.getModel("faux", "routine-model")!,
    work: runtime.getModel("faux", "work-model")!,
  };
  const escalations: EscalationRecord[] = [];
  const settingsManager = SettingsManager.inMemory();
  const routed = route(models);
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    systemPrompt: "test",
    noExtensions: true,
    extensionFactories: [
      captainRoutingExtension({ current: () => routed, onEscalated: (record) => escalations.push(record) }),
    ],
    noPromptTemplates: true,
    settingsManager,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: dir,
    model: models.routine,
    thinkingLevel: "off",
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(dir),
    settingsManager,
    noTools: "builtin",
  });
  await session.bindExtensions({ mode: "print" });
  return { session, core, calls, escalations, models };
}

function selection(model: Model<Api>): PiModelSelection {
  return { model, ref: `${model.provider}/${model.id}`, thinkingLevel: "off" };
}

describe("routing on a real Pi session", () => {
  it("runs the calls after an escalate tool call on the work model, in the same run", async () => {
    const pi = await piSession((models) => ({
      route: {
        purpose: "discord_social",
        tier: "routine",
        ref: "faux/routine-model",
        escalation: { ref: "faux/work-model", turnLimit: 10 },
      },
      selection: selection(models.routine),
      resolveEscalation: () => Promise.resolve(selection(models.work)),
    }));
    pi.core.setResponses([
      fauxAssistantMessage(fauxToolCall(ESCALATE_TOOL_NAME, { reason: "this is real work" })),
      fauxAssistantMessage("done on the work model"),
    ]);
    await pi.session.prompt("fix the build");
    expect(pi.calls).toEqual(["routine-model", "work-model"]);
    expect(pi.session.getLastAssistantText()).toBe("done on the work model");
    expect(pi.escalations).toEqual([
      { purpose: "discord_social", from: "faux/routine-model", to: "faux/work-model", trigger: "asked" },
    ]);
    // One user message: escalation continued the run rather than replaying it.
    expect(pi.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("keeps a non-escalating routine run on the routine model for every call", async () => {
    const pi = await piSession((models) => ({
      route: { purpose: "discord_social", tier: "routine", ref: "faux/routine-model" },
      selection: selection(models.routine),
    }));
    pi.core.setResponses([
      fauxAssistantMessage(fauxToolCall(ESCALATE_TOOL_NAME, {})),
      fauxAssistantMessage("still routine"),
    ]);
    await pi.session.prompt("hi");
    expect(pi.calls.every((id) => id === "routine-model")).toBe(true);
    expect(pi.escalations).toEqual([]);
  });

  it("retries a retryable routine failure on the work model", async () => {
    const pi = await piSession((models) => ({
      route: {
        purpose: "discord_social",
        tier: "routine",
        ref: "faux/routine-model",
        escalation: { ref: "faux/work-model", turnLimit: 10 },
      },
      selection: selection(models.routine),
      resolveEscalation: () => Promise.resolve(selection(models.work)),
    }));
    pi.core.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 Service Unavailable: overloaded" }),
      fauxAssistantMessage("recovered"),
    ]);
    await pi.session.prompt("hi");
    expect(pi.calls).toEqual(["routine-model", "work-model"]);
    expect(pi.session.getLastAssistantText()).toBe("recovered");
    expect(pi.escalations.map((record) => record.trigger)).toEqual(["provider_error"]);
  });
});
