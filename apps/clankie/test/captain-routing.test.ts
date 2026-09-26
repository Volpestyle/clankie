import type { PiModelSelection } from "@clankie/model-provider";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { sessionPurpose } from "../src/captain/captain.ts";
import type { RoutedSelection } from "../src/captain/model.ts";
import {
  captainRoutingExtension,
  ESCALATE_TOOL_NAME,
  RoutineRunBudget,
  type EscalationRecord,
} from "../src/captain/routing.ts";

function selection(ref: string): PiModelSelection {
  const [provider, id] = ref.split("/") as [string, string];
  return { ref, thinkingLevel: "medium", model: { provider, id } } as unknown as PiModelSelection;
}

const ROUTINE = selection("openai/routine-model");
const WORK = selection("openai/work-model");

function routineRoute(options: { escalate: boolean; turnLimit?: number }): RoutedSelection {
  return {
    route: {
      purpose: "discord_social",
      tier: "routine",
      ref: ROUTINE.ref,
      ...(options.escalate ? { escalation: { ref: WORK.ref, turnLimit: options.turnLimit ?? 3 } } : {}),
    },
    selection: ROUTINE,
    ...(options.escalate ? { resolveEscalation: () => Promise.resolve(WORK) } : {}),
  };
}

const WORK_ROUTE: RoutedSelection = {
  route: { purpose: "operator", tier: "work", ref: WORK.ref },
  selection: WORK,
};

type Handler = (event: unknown) => Promise<unknown>;

/** A Pi extension host that records what the routing extension does to the session. */
async function harness(current: () => RoutedSelection | undefined) {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  let active = ["read", "bash"];
  const setModel = vi.fn((_model: unknown) => Promise.resolve(true));
  const setThinkingLevel = vi.fn();
  const entries: unknown[] = [];
  const escalations: EscalationRecord[] = [];
  await captainRoutingExtension({ current, onEscalated: (record) => escalations.push(record) }).factory({
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
      tools.set(tool.name, tool);
    },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
    setModel,
    setThinkingLevel,
    appendEntry: (_type: string, data: unknown) => entries.push(data),
  } as unknown as ExtensionAPI);
  const emit = async (event: string, payload: unknown = {}) => await handlers.get(event)?.(payload);
  return {
    setModel,
    setThinkingLevel,
    entries,
    escalations,
    active: () => active,
    startRun: async () =>
      (await emit("before_agent_start", { systemPrompt: "base" })) as { systemPrompt: string } | undefined,
    modelCall: async () => await emit("turn_end"),
    failedCall: async (errorMessage: string) =>
      await emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage } }),
    askToEscalate: async () => {
      const result = (await tools.get(ESCALATE_TOOL_NAME)?.execute("call", {})) as {
        content: Array<{ text: string }>;
      };
      return result.content[0]?.text;
    },
  };
}

describe("RoutineRunBudget", () => {
  it("escalates at most once per run, at the call limit", () => {
    const budget = new RoutineRunBudget();
    budget.start(3);
    expect(budget.modelCallEnded()).toBeUndefined();
    expect(budget.modelCallEnded()).toBeUndefined();
    expect(budget.modelCallEnded()).toBe("looping");
    expect(budget.claim()).toBe(true);
    expect(budget.claim()).toBe(false);
    expect(budget.modelCallEnded()).toBeUndefined();
    expect(budget.modelCallFailed(true)).toBeUndefined();

    budget.start(3);
    expect(budget.canEscalate).toBe(true);
  });

  it("never escalates a run that may not, and never on an error Pi will not retry", () => {
    const budget = new RoutineRunBudget();
    budget.start(undefined);
    for (let call = 0; call < 50; call += 1) expect(budget.modelCallEnded()).toBeUndefined();
    expect(budget.modelCallFailed(true)).toBeUndefined();
    expect(budget.claim()).toBe(false);

    budget.start(3);
    expect(budget.modelCallFailed(false)).toBeUndefined();
    expect(budget.modelCallFailed(true)).toBe("provider_error");
  });
});

describe("captainRoutingExtension", () => {
  it("never moves a routine run when escalation is off, however long it runs or fails", async () => {
    const pi = await harness(() => routineRoute({ escalate: false }));
    const prompt = await pi.startRun();
    expect(prompt?.systemPrompt).toContain("routine model (`openai/routine-model`)");
    expect(pi.active()).not.toContain(ESCALATE_TOOL_NAME);
    for (let call = 0; call < 20; call += 1) await pi.modelCall();
    await pi.failedCall("503 Service Unavailable: overloaded");
    expect(await pi.askToEscalate()).toBe("This turn cannot escalate.");
    expect(pi.setModel).not.toHaveBeenCalled();
    expect(pi.escalations).toEqual([]);
  });

  it("leaves work routes alone and hides the tool", async () => {
    const pi = await harness(() => WORK_ROUTE);
    expect(await pi.startRun()).toBeUndefined();
    expect(pi.active()).not.toContain(ESCALATE_TOOL_NAME);
    for (let call = 0; call < 20; call += 1) await pi.modelCall();
    expect(pi.setModel).not.toHaveBeenCalled();
  });

  it("escalates once when he asks, recording the move", async () => {
    const pi = await harness(() => routineRoute({ escalate: true }));
    const prompt = await pi.startRun();
    expect(prompt?.systemPrompt).toContain("call `escalate`");
    expect(pi.active()).toEqual(["read", "bash", ESCALATE_TOOL_NAME]);

    expect(await pi.askToEscalate()).toBe("The rest of this turn runs on openai/work-model.");
    expect(await pi.askToEscalate()).toBe("This turn has already escalated.");
    for (let call = 0; call < 20; call += 1) await pi.modelCall();

    expect(pi.setModel).toHaveBeenCalledTimes(1);
    expect(pi.setModel).toHaveBeenCalledWith(WORK.model);
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("medium");
    const record = { purpose: "discord_social", from: ROUTINE.ref, to: WORK.ref, trigger: "asked" };
    expect(pi.escalations).toEqual([record]);
    expect(pi.entries).toEqual([record]);
  });

  it("escalates a looping run at its call limit, and the next run starts with a fresh budget", async () => {
    const pi = await harness(() => routineRoute({ escalate: true, turnLimit: 3 }));
    await pi.startRun();
    await pi.modelCall();
    await pi.modelCall();
    expect(pi.setModel).not.toHaveBeenCalled();
    await pi.modelCall();
    expect(pi.escalations.map((record) => record.trigger)).toEqual(["looping"]);

    await pi.startRun();
    await pi.modelCall();
    expect(pi.setModel).toHaveBeenCalledTimes(1);
    expect(await pi.askToEscalate()).toBe("The rest of this turn runs on openai/work-model.");
    expect(pi.setModel).toHaveBeenCalledTimes(2);
  });

  it("moves Pi's retry of a retryable failure onto the escalation model, but not a permanent failure", async () => {
    const pi = await harness(() => routineRoute({ escalate: true }));
    await pi.startRun();
    await pi.failedCall("400 Bad Request: invalid schema");
    expect(pi.setModel).not.toHaveBeenCalled();
    await pi.failedCall("503 Service Unavailable: the model is overloaded");
    expect(pi.escalations.map((record) => record.trigger)).toEqual(["provider_error"]);
  });

  it("reads the route afresh each run, so an owner's change applies on the next turn", async () => {
    let routed = routineRoute({ escalate: false });
    const pi = await harness(() => routed);
    await pi.startRun();
    expect(pi.active()).not.toContain(ESCALATE_TOOL_NAME);
    routed = routineRoute({ escalate: true });
    await pi.startRun();
    expect(pi.active()).toContain(ESCALATE_TOOL_NAME);
  });

  it("keeps a failed escalation out of the turn's way", async () => {
    const broken: RoutedSelection = {
      ...routineRoute({ escalate: true, turnLimit: 1 }),
      resolveEscalation: () => Promise.reject(new Error("Escalation model openai/gone: no Pi entry")),
    };
    const pi = await harness(() => broken);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await pi.startRun();
    await expect(pi.modelCall()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "Routine turn could not escalate (looping):",
      "Escalation model openai/gone: no Pi entry",
    );
    warn.mockRestore();
    expect(pi.setModel).not.toHaveBeenCalled();
  });
});

describe("sessionPurpose", () => {
  it("maps each session to the purpose routing reads", () => {
    expect(sessionPurpose("operator", true)).toBe("operator");
    expect(sessionPurpose("gameplay", false)).toBe("gameplay");
    expect(sessionPurpose("discord_presence", false)).toBe("discord_social");
    expect(sessionPurpose("discord_voice", false)).toBe("discord_social");
    expect(sessionPurpose("discord_presence", true)).toBe("discord_granted");
    expect(sessionPurpose("discord_voice", true)).toBe("discord_granted");
  });
});
