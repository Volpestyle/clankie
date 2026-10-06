import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { GbaEmulatorObservation } from "@clankie/interactive-environment";
import type { GbaDriverIo } from "../src/body-seam.ts";
import { createModelFreePlayMind, createModelVoice } from "../src/free-play-mind.ts";
import {
  InterjectionQueue,
  runFreePlay,
  type FreePlayNotable,
  type FreePlayTurnEvidence,
} from "../src/free-play.ts";
import { emptyFreePlayUsage, type FreePlayUsage } from "../src/free-play-usage.ts";

const action = { kind: "button_press" as const, button: "a" as const, holdFrames: 2 };
const decision = { monologue: "looking", intent: "press a", action };
const wire = {
  ...decision,
  action: undefined,
  actionKind: "button_press",
  button: "a",
  holdFrames: 2,
  notes: null,
  objective: null,
  reply: null,
  speak: null,
  repeat: null,
  x: null,
  y: null,
  text: null,
  entryId: null,
  frames: null,
};
function io(observation?: () => GbaEmulatorObservation): GbaDriverIo {
  return {
    observe: (kind) => {
      const value = observation?.();
      if (value?.kind !== kind) throw new Error("no observation");
      return value;
    },
    act: async () => ({
      schemaVersion: 1,
      actionId: "fake-action",
      sessionId: "fake-session",
      updatedAt: "2026-10-06T00:00:00.000Z",
      status: "completed",
      acceptedGoalVersion: 1,
      outcome: {},
    }),
    pause: async () => {},
    resume: async () => {},
  };
}
function observation(mode: "overworld" | "battle" | "menu" | "dialog"): GbaEmulatorObservation {
  return {
    schemaVersion: 1,
    kind: "scene",
    observationId: "fixture-scene",
    sessionId: "fake-session",
    characterId: "clankie",
    worldId: "fixture-world",
    goalVersion: 1,
    capturedAt: "2026-10-06T00:00:00.000Z",
    frame: 1,
    data: { mode, inputReady: true, waitingForDialogAdvance: false },
  } as GbaEmulatorObservation;
}
function model(json: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "0" });
          controller.enqueue({ type: "text-delta", id: "0", delta: json });
          controller.enqueue({ type: "text-end", id: "0" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 10, noCache: 7, cacheRead: 2, cacheWrite: 1 },
              outputTokens: { total: 5, text: 4, reasoning: 1 },
            },
          });
          controller.close();
        },
      }),
    }),
  });
}
const usage: FreePlayUsage = {
  ...emptyFreePlayUsage(),
  calls: 1,
  inputTokens: 10,
  outputTokens: 5,
  chargedTokens: 15,
  estimatedCostUsd: 0.01,
};

describe("Pokémon play robustness with offline fixtures", () => {
  it("retains bursty room messages in order and bounds queue overflow", () => {
    const queue = new InterjectionQueue(32);
    for (let i = 0; i < 40; i++) queue.offer(`line ${i}`);
    for (let i = 0; i < 31; i++) expect(queue.take()).toBe(`line ${i}`);
    expect(queue.take()).toContain("line 39");
    expect(queue.take()).toBeNull();
  });

  it("delivers all deferred text after a full 32-slot queue overflows", async () => {
    const interjections = new InterjectionQueue(32);
    const lines = Array.from({ length: 40 }, (_, i) => `${String(i).padStart(2, "0")}:` + "x".repeat(497));
    for (const line of lines) interjections.offer(line);
    const seen: string[] = [];
    const result = await runFreePlay({
      io: io(),
      turns: 50,
      interjections,
      mind: {
        decide: async (view) => {
          if (view.interjection !== null) seen.push(view.interjection);
          return decision;
        },
      },
    });
    expect(result.accepted).toBe(50);
    expect(seen.every((text) => text.length <= 500)).toBe(true);
    expect(seen.join("").replaceAll("\n", "")).toBe(lines.join(""));
    expect(interjections.hasPending()).toBe(false);
  });

  it("backs off for invalid decisions and observes stop during a retry", async () => {
    let stop = false;
    let calls = 0;
    const result = await runFreePlay({
      io: io(),
      turns: 100,
      shouldStop: () => stop,
      mind: {
        decide: async () => {
          calls++;
          return {};
        },
      },
      sleep: async () => {
        stop = true;
      },
    });
    expect(calls).toBe(1);
    expect(result.turns[0]?.outcome).toBe("invalid_decision");
  });
  it("accounts for the real SDK's mind and voice usage including cached input", async () => {
    const pricing = { input: 2, output: 4, cacheRead: 0.5, cacheWrite: 3 };
    const result = await runFreePlay({
      io: io(),
      turns: 20,
      budget: { maxTokens: 30 },
      mind: createModelFreePlayMind({ model: model(JSON.stringify(wire)), pricing }),
      voice: createModelVoice({ model: model(JSON.stringify({ speak: null, reply: null })), pricing }),
    });
    expect(result.accepted).toBe(1);
    expect(result.outcome).toBe("budget_exhausted");
    expect(result.turns[0]?.usage).toMatchObject({
      calls: 2,
      inputTokens: 20,
      outputTokens: 10,
      chargedTokens: 30,
      unreportedCalls: 0,
    });
    expect(result.usage?.estimatedCostUsd).toBeCloseTo(0.000076);
  });

  it("stops on a cost ceiling before buying another decision", async () => {
    let calls = 0;
    const events: FreePlayNotable[] = [];
    const result = await runFreePlay({
      io: io(),
      turns: 100,
      budget: { maxCostUsd: 0.02 },
      onNotable: (event) => events.push(event),
      mind: {
        decide: async (_view, _signal, report) => {
          calls++;
          report?.(usage);
          return decision;
        },
      },
    });
    expect(calls).toBe(2);
    expect(result.accepted).toBe(1);
    expect(result.outcome).toBe("budget_exhausted");
    expect(events).toEqual([{ kind: "budget_exhausted", turn: 2, count: 30 }]);
  });

  it("fails closed when a dollar-capped SDK call has no registry price", async () => {
    const result = await runFreePlay({
      io: io(),
      turns: 100,
      budget: { maxCostUsd: 1 },
      mind: createModelFreePlayMind({ model: model(JSON.stringify(wire)) }),
    });
    expect(result.outcome).toBe("budget_exhausted");
    expect(result.accepted).toBe(0);
    expect(result.usage).toMatchObject({ calls: 1, chargedTokens: 15, estimatedCostUsd: null });
  });

  it("charges aborted proposals and retains late room lines while turns complete", async () => {
    const interjections = new InterjectionQueue(32);
    let calls = 0;
    const seen: (string | null)[] = [];
    const evidence: FreePlayTurnEvidence[] = [];
    const result = await runFreePlay({
      io: io(),
      turns: 2,
      interjections,
      mind: {
        decide: async (view, _signal, report) => {
          calls++;
          seen.push(view.interjection);
          report?.(usage);
          interjections.offer(`line ${calls}`);
          return decision;
        },
      },
      onTurn: (_turn, value) => evidence.push(value),
    });
    expect(calls).toBe(6);
    expect(result.accepted).toBe(2);
    expect(evidence.map((value) => value.signals.decisionPreemptions)).toEqual([2, 2]);
    expect(result.usage).toMatchObject({ calls: 6, chargedTokens: 90 });
    expect(seen[3]).toBe("line 3");
    expect(interjections.take()).toBe("line 6");
  });

  it("reserves tokens when an interrupted metered call cannot report usage", async () => {
    const interjections = new InterjectionQueue(32);
    const result = await runFreePlay({
      io: io(),
      turns: 10,
      interjections,
      budget: { maxTokens: 16_000 },
      mind: {
        metered: true,
        decide: () => {
          interjections.offer("hi");
          return new Promise(() => {});
        },
      },
    });
    expect(result.outcome).toBe("budget_exhausted");
    expect(result.turns[0]?.usage).toMatchObject({
      calls: 1,
      unreportedCalls: 1,
      chargedTokens: 16_000,
      estimatedCostUsd: null,
    });
  });

  it("backs off exponentially, resets on recovery, and stops after five failures", async () => {
    const delays: number[] = [];
    const events: FreePlayNotable[] = [];
    let calls = 0;
    const result = await runFreePlay({
      io: io(),
      turns: 100,
      sleep: async (ms) => {
        delays.push(ms);
      },
      onNotable: (event) => events.push(event),
      mind: {
        decide: async () => {
          calls++;
          if (calls === 3) return decision;
          throw new Error("401 provider unavailable");
        },
      },
    });
    expect(calls).toBe(8);
    expect(delays).toEqual([1000, 2000, 1000, 2000, 4000, 8000]);
    expect(result.accepted).toBe(1);
    expect(result.outcome).toBe("mind_unavailable");
    expect(events).toContainEqual({ kind: "mind_unavailable", turn: 7, count: 5 });
  });

  it.each(["battle", "menu", "dialog"] as const)(
    "re-decides when %s starts while thinking and never sends the stale button",
    async (changedMode) => {
      let mode: "overworld" | "battle" | "menu" | "dialog" = "overworld";
      const body = io(() => observation(mode));
      const actions: unknown[] = [];
      body.act = async (value) => {
        actions.push(value);
        return io().act(value);
      };
      let calls = 0;
      let evidence: FreePlayTurnEvidence | undefined;
      const result = await runFreePlay({
        io: body,
        turns: 1,
        mind: {
          decide: async (view) => {
            calls++;
            if (calls === 1) {
              mode = changedMode;
              return { ...decision, action: { ...action, button: "left" } };
            }
            expect(view.observations[0]).toMatchObject({ data: { mode: changedMode } });
            return decision;
          },
        },
        onTurn: (_turn, value) => {
          evidence = value;
        },
      });
      expect(calls).toBe(2);
      expect(actions).toEqual([action]);
      expect(result.accepted).toBe(1);
      expect(evidence?.signals.stateRedecisions).toBe(1);
      expect(evidence?.decision.observations[0]).toMatchObject({ data: { mode: changedMode } });
    },
  );

  it("abandons a continuously changing scene after two re-decisions", async () => {
    let mode: "overworld" | "battle" = "overworld";
    const result = await runFreePlay({
      io: io(() => observation(mode)),
      turns: 1,
      mind: {
        decide: async () => {
          mode = mode === "overworld" ? "battle" : "overworld";
          return decision;
        },
      },
    });
    expect(result.accepted).toBe(0);
    expect(result.turns[0]?.outcome).toBe("state_changed");
  });

  it("reports a persistent stuck state only once", async () => {
    const events: FreePlayNotable[] = [];
    const result = await runFreePlay({
      io: io(),
      turns: 50,
      mind: { decide: async () => decision },
      onNotable: (event) => events.push(event),
    });
    expect(result.accepted).toBe(50);
    expect(events.filter((event) => event.kind === "stuck")).toHaveLength(1);
  });
});
