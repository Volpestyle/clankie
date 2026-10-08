import { evaluateFreePlayJournal } from "../../../packages/play/src/free-play-evaluator.ts";
/** Real HTTP model/body boundaries, filesystem journal, and authenticated play-voice WS. */
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLanguageModel } from "@clankie/model-provider";
import {
  InterjectionQueue,
  parseFreePlayJournal,
  projectPlayStory,
  listPlayJourneyRuns,
  latestPlayJourneyContinuity,
} from "@clankie/play";
import { createPlayVoiceClient, createPlayVoiceListener } from "@clankie/play-voice";
import {
  MinecraftActionRequestSchema,
  MinecraftActionStatusSchema,
  MinecraftObservationSchema,
  type MinecraftActionStatus,
  type MinecraftObservation,
} from "@clankie/protocol";
import { createModelMinecraftPlayMind } from "../src/minecraft-play-mind.ts";
import {
  runMinecraftPlay,
  type RunMinecraftPlayInput,
  type MinecraftPlayTurn,
} from "../src/minecraft-play.ts";

const session = { sessionId: "minecraft-contract-session", connectionGeneration: 1 };
function answer(actionKind = "wait", objective: string | null = "my goal") {
  return {
    monologue: "I am considering what I observed.",
    intent: "Use the observed context.",
    notes: "Remember the verified result.",
    objective,
    speakWanted: true,
    actionKind,
    x: 1,
    y: 64,
    z: 1,
    text: "An authored game message.",
    player: "James",
    item: "minecraft:dirt",
    count: 1,
    tolerance: 1,
    distance: 3,
    placements: null,
  };
}
async function fixture(
  options: {
    answers?: ReturnType<typeof answer>[];
    fail?: boolean;
    modelDelayMs?: number;
    onModel?: (call: number) => void;
    mode?: (observationCount: number) => string;
    health?: (observationCount: number) => number;
    alone?: boolean;
    running?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "minecraft-play-boundary-"));
  const requests: { at: number; body: Record<string, unknown> }[] = [];
  const actions: MinecraftActionStatus[] = [];
  const cancellations: string[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  let observations = 0;
  let changed = false;
  const observe = (): MinecraftObservation =>
    MinecraftObservationSchema.parse({
      session,
      observedAt: Date.now(),
      facts: [
        {
          source: "bot_cache",
          observedAt: Date.now(),
          fact: { type: "position", player: "Clankie", position: { x: 0, y: 64, z: 0 } },
        },
        {
          source: "bot_cache",
          observedAt: Date.now(),
          fact: { type: "health", player: "Clankie", health: options.health?.(observations) ?? 20, food: 20 },
        },
        ...(!options.alone
          ? [
              {
                source: "bot_cache",
                observedAt: Date.now(),
                fact: { type: "position", player: "James", position: { x: 2, y: 64, z: 0 } },
              },
            ]
          : []),
        {
          source: "server_packet",
          observedAt: Date.now(),
          fact: {
            type: "block",
            position: { x: 1, y: 64, z: 1 },
            block: changed ? "minecraft:air" : "minecraft:dirt",
          },
        },
      ],
    });
  const server = createServer((request, response) => {
    void (async () => {
      let raw = "";
      for await (const part of request) raw += String(part);
      const body = raw ? JSON.parse(raw) : null;
      const path = request.url ?? "";
      const json = (value: unknown) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(value));
      };
      if (path === "/observe") {
        observations++;
        json(observe());
        return;
      }
      if (path === "/mode") {
        json(options.mode?.(observations) ?? "active:session:1:driver:1");
        return;
      }
      if (path === "/act") {
        const action = MinecraftActionRequestSchema.parse(body);
        const now = Date.now();
        changed ||= action.action.type === "dig";
        const evidence =
          action.action.type === "dig"
            ? {
                outcome: "verified",
                source: "server_packet",
                observedAt: now,
                checks: [
                  {
                    type: "block",
                    position: action.action.position,
                    expected: "minecraft:air",
                    observed: "minecraft:air",
                  },
                ],
              }
            : { outcome: "unknown", reason: "local_report_only" };
        const status = MinecraftActionStatusSchema.parse({
          session,
          actionId: action.actionId,
          requested: action.action,
          state: options.running ? "running" : "completed",
          requestedAt: now,
          updatedAt: now,
          evidence,
        });
        actions.push(status);
        json(status);
        return;
      }
      if (path.startsWith("/cancel/")) {
        const id = path.slice(8);
        cancellations.push(id);
        const status = actions.find((entry) => entry.actionId === id);
        if (!status) throw new Error("Unknown fixture action");
        status.state = "cancelled";
        status.evidence = { outcome: "unknown", reason: "interrupted" };
        status.updatedAt = Date.now();
        json(status);
        return;
      }
      if (path.startsWith("/status/")) {
        json(actions.find((entry) => entry.actionId === path.slice(8)) ?? null);
        return;
      }
      requests.push({ at: Date.now(), body });
      const call = requests.length;
      options.onModel?.(call);
      if (options.fail) {
        response.statusCode = 503;
        json({ error: { message: "Boundary fixture unavailable" } });
        return;
      }
      const send = () => {
        if (response.destroyed) return;
        response.setHeader("content-type", "text/event-stream");
        const chunk = (choices: unknown[], usage?: object) =>
          `data: ${JSON.stringify({ id: `call-${call}`, object: "chat.completion.chunk", created: 1, model: "contract", choices, ...(usage ? { usage } : {}) })}\n\n`;
        response.end(
          chunk([
            {
              index: 0,
              delta: { role: "assistant", content: JSON.stringify(options.answers?.[call - 1] ?? answer()) },
              finish_reason: null,
            },
          ]) +
            chunk([{ index: 0, delta: {}, finish_reason: "stop" }]) +
            chunk([], { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }) +
            "data: [DONE]\n\n",
        );
      };
      if (options.modelDelayMs) timers.push(setTimeout(send, options.modelDelayMs));
      else send();
    })().catch(() => {
      if (!response.writableEnded) {
        response.statusCode = 500;
        response.end();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture address missing");
  const url = `http://127.0.0.1:${address.port}`;
  const rpc = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(url + path, {
      method: body ? "POST" : "GET",
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error("Fixture RPC failed");
    return (await response.json()) as T;
  };
  const model = createLanguageModel({
    provider: {
      id: "openrouter",
      name: "Contract endpoint",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      api: url,
      models: {},
    },
    modelId: "contract",
    credential: { type: "api", key: "isolated-fixture-only" },
  });
  const input: RunMinecraftPlayInput = {
    session,
    journeyId: "minecraft:contract-world",
    journalRoot: root,
    mind: createModelMinecraftPlayMind({ model, pricing: { input: 1, output: 2 }, requestTimeoutMs: 2000 }),
    body: {
      observe: () => rpc("/observe"),
      mode: () => rpc("/mode"),
      act: (body) => rpc("/act", body),
      actionStatus: (id) => rpc(`/status/${id}`),
      cancel: (id) => rpc(`/cancel/${id}`, {}),
    },
    budget: { maxTokens: 10000, maxCostUsd: 1, maxTurns: 1 },
    shouldStop: () => false,
    createVoice: async () => undefined,
    turnIntervalMs: 1,
    idleBackoffMs: 1,
  };
  return {
    input,
    requests,
    actions,
    cancellations,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function journal(path: string) {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("Minecraft loop across its production boundaries", () => {
  it("feeds the shared journal evaluator, story and journey readers with native Minecraft evidence", async () => {
    const f = await fixture({ answers: [answer("dig"), answer("wait")] });
    try {
      const result = await runMinecraftPlay({ ...f.input, budget: { ...f.input.budget, maxTurns: 2 } });
      const contents = await readFile(result.journalPath, "utf8");
      const raw = await journal(result.journalPath);
      expect(
        raw.every(
          (line) =>
            line.runId === raw[0].runId &&
            line.environmentId === "minecraft" &&
            line.environmentSessionId === session.sessionId &&
            line.venue === "world" &&
            line.journeyId === f.input.journeyId,
        ),
      ).toBe(true);
      expect(raw.map((line) => line.schemaVersion)).toEqual(
        raw.map((line) => (line.kind === "header" ? 3 : 2)),
      );
      const lines = parseFreePlayJournal(contents);
      const evaluation = evaluateFreePlayJournal({ journal: contents });
      expect(evaluation.aggregate).toMatchObject({
        turns: 2,
        retiredActionTurns: 0,
        outcomes: { settled: 1, waited: 1 },
      });
      expect(evaluation.turns[0]).toMatchObject({
        decision: { action: { type: "dig" }, actionRetired: false, outcome: "settled" },
        evidence: null,
        gameEvidence: {
          before: { session },
          action: { state: "completed", evidence: { outcome: "verified" } },
        },
      });
      expect(evaluation.aggregate.summary?.usage).toMatchObject({
        calls: 2,
        inputTokens: 200,
        outputTokens: 40,
        chargedTokens: 240,
        unreportedCalls: 0,
      });
      const story = projectPlayStory({ sessionId: session.sessionId, environmentId: "minecraft", lines });
      expect(story).toMatchObject({
        environmentId: "minecraft",
        turnsTaken: 2,
        objective: "my goal",
        maps: [],
      });
      expect(story.moments[0]?.effect).toContain("verified");
      expect(listPlayJourneyRuns(f.input.journalRoot, f.input.journeyId)).toHaveLength(1);
      expect(latestPlayJourneyContinuity(f.input.journalRoot, f.input.journeyId)).toEqual({
        notes: "Remember the verified result.",
        objective: "my goal",
      });
      const corrupt = contents.replace('"environmentId":"minecraft"', '"environmentId":"pokemon-firered"');
      expect(() => parseFreePlayJournal(corrupt)).toThrow();
    } finally {
      await f.close();
    }
  });
  it("keeps native movement distinct from Pokémon tile scoring", async () => {
    const f = await fixture({ answers: [answer("goto")] });
    try {
      const result = await runMinecraftPlay(f.input);
      const evaluation = evaluateFreePlayJournal({ journal: await readFile(result.journalPath, "utf8") });
      expect(evaluation.turns[0]).toMatchObject({
        decision: { action: { type: "goto" }, actionRetired: false },
        movement: { attempted: true, effectiveness: "unknown", start: null, end: null },
        gameEvidence: { action: { evidence: { outcome: "unknown", reason: "local_report_only" } } },
      });
      expect(evaluation.aggregate.retiredActionTurns).toBe(0);
    } finally {
      await f.close();
    }
  });
  it("retains a stale decision as a native journal outcome without inventing action evidence", async () => {
    const f = await fixture({ answers: [answer("dig"), answer()], health: (count) => (count >= 2 ? 4 : 20) });
    try {
      const result = await runMinecraftPlay({ ...f.input, budget: { ...f.input.budget, maxTurns: 2 } });
      const evaluation = evaluateFreePlayJournal({ journal: await readFile(result.journalPath, "utf8") });
      expect(evaluation.aggregate.outcomes).toEqual({ stale_decision: 1, waited: 1 });
      expect(evaluation.turns[0]).toMatchObject({
        decision: { outcome: "stale_decision", action: { type: "dig" }, actionRetired: false },
        evidence: null,
        gameEvidence: { action: null },
      });
      expect(f.actions).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  it("remembers verified effects, journals usage/journey and offers authored experiences to the real voice bridge", async () => {
    const f = await fixture({
      answers: [answer("dig", "first"), answer("chat", "second"), answer("wait", "third")],
    });
    const narration: { event: string; respond: boolean }[] = [];
    const listener = createPlayVoiceListener({
      token: "voice-fixture",
      room: () => ({ listening: true }),
      narrate: async (event, options) => {
        narration.push({ event, respond: options?.respond ?? false });
      },
    });
    const port = await listener.listen(0);
    listener.publishRoom({ listening: true });
    const voice = createPlayVoiceClient({ token: "voice-fixture", url: `ws://127.0.0.1:${port}/play` });
    try {
      for (let i = 0; i < 100 && !voice.roomListening; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      const notable: string[] = [];
      const result = await runMinecraftPlay({
        ...f.input,
        budget: { ...f.input.budget, maxTurns: 3 },
        createVoice: async () => voice,
        onNotable: (event) => {
          notable.push(event.kind);
        },
      });
      expect(result).toMatchObject({
        outcome: "budget_exhausted",
        turnsTaken: 3,
        inputTokens: 300,
        outputTokens: 60,
        unknownUsageCalls: 0,
        notes: "Remember the verified result.",
      });
      expect(result.costUsd).toBeCloseTo(0.00042);
      expect(f.actions.map((entry) => entry.requested.type)).toEqual(["dig", "chat"]);
      const lines = await journal(result.journalPath);
      expect(lines.every((line) => line.journeyId === "minecraft:contract-world")).toBe(true);
      expect(lines.filter((line) => line.kind === "usage")).toHaveLength(3);
      expect(lines.find((line) => line.kind === "turn").turn.action.evidence.outcome).toBe("verified");
      const secondMessages = (f.requests[1]?.body.messages ?? []) as { content: string }[];
      const secondView = JSON.parse(secondMessages.at(-1)?.content ?? "{}");
      expect(secondView.history[0].effect).toContain("verified");
      expect(secondView.notes).toBe("Remember the verified result.");
      expect(notable).toContain("objective_retired_twice");
      expect(narration.length).toBeGreaterThan(0);
      expect(narration[0]?.event).toContain("thought=");
      expect(narration[0]?.event).not.toBe(answer().monologue);
      expect(narration.filter((entry) => entry.respond)).toHaveLength(1);
    } finally {
      voice.close();
      await listener.close();
      await f.close();
    }
  });
  it("does not act on a health-mode change while the decision was in flight", async () => {
    const f = await fixture({ answers: [answer("dig"), answer()], health: (count) => (count >= 2 ? 4 : 20) });
    try {
      const turns: MinecraftPlayTurn[] = [];
      await runMinecraftPlay({
        ...f.input,
        budget: { ...f.input.budget, maxTurns: 2 },
        onTurn: (turn) => turns.push(turn),
      });
      expect(turns.map((turn) => turn.outcome)).toEqual(["stale_decision", "waited"]);
      expect(f.actions).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  it.each([
    { maxTokens: 100, maxCostUsd: 1 },
    { maxTokens: 10000, maxCostUsd: 0.0001 },
  ])(
    "stops before acting when reported spend reaches a ceiling ($maxTokens tokens, $maxCostUsd USD)",
    async (budget) => {
      const f = await fixture({ answers: [answer("dig")] });
      try {
        const result = await runMinecraftPlay({ ...f.input, budget });
        expect(result.outcome).toBe("budget_exhausted");
        expect(f.requests).toHaveLength(1);
        expect(f.actions).toHaveLength(0);
      } finally {
        await f.close();
      }
    },
  );
  it("backs off rejected decisions with known billed usage and informs the captain", async () => {
    const invalid = { ...answer(), monologue: "" };
    const f = await fixture({ answers: [invalid, invalid, invalid] });
    try {
      const notable: string[] = [];
      const result = await runMinecraftPlay({
        ...f.input,
        budget: { ...f.input.budget, maxTurns: 10 },
        failureBackoffMs: 20,
        onNotable: (event) => {
          notable.push(event.kind);
        },
      });
      expect(result.outcome).toBe("mind_unavailable");
      expect(f.requests).toHaveLength(3);
      expect((f.requests[1]?.at ?? 0) - (f.requests[0]?.at ?? 0)).toBeGreaterThanOrEqual(20);
      expect((f.requests[2]?.at ?? 0) - (f.requests[1]?.at ?? 0)).toBeGreaterThanOrEqual(40);
      expect(notable).toEqual(["mind_unavailable"]);
      expect(f.actions).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  it("settles and accounts chat-preempted decisions, discarding at most two before acting", async () => {
    const queue = new InterjectionQueue();
    const f = await fixture({
      modelDelayMs: 100,
      onModel: (call) => {
        setTimeout(() => queue.offer(`Room message ${call}`), 5);
      },
    });
    try {
      const turns: MinecraftPlayTurn[] = [];
      const result = await runMinecraftPlay({
        ...f.input,
        interjections: queue,
        onTurn: (turn) => turns.push(turn),
      });
      expect(result.turnsTaken).toBe(1);
      expect(result.outcome).toBe("budget_exhausted");
      expect(f.requests).toHaveLength(3);
      expect(turns[0]?.preemptions).toBe(2);
      expect(queue.hasPending()).toBe(true);
      expect(result.unknownUsageCalls).toBe(0);
      expect(result.inputTokens).toBe(300);
      expect(result.costUsd).toBeCloseTo(0.00042);
    } finally {
      await f.close();
    }
  });
  it("does not treat a failed provider call with missing usage as free", async () => {
    const f = await fixture({ fail: true });
    try {
      const result = await runMinecraftPlay({ ...f.input, budget: { ...f.input.budget, maxTurns: 10 } });
      expect(result.outcome).toBe("mind_unavailable");
      expect(result.unknownUsageCalls).toBe(1);
      expect(f.requests).toHaveLength(1);
      expect(f.actions).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  it("slices continuous follow, cancels its exact action and records unknown effects honestly", async () => {
    const f = await fixture({ answers: [answer("follow")], running: true });
    try {
      const result = await runMinecraftPlay({ ...f.input, actionSliceMs: 25 });
      expect(f.cancellations).toEqual([f.actions[0]?.actionId]);
      const line = (await journal(result.journalPath)).find((entry) => entry.kind === "turn");
      expect(line.turn.action.state).toBe("cancelled");
      expect(line.turn.effect).toContain("Effect unknown");
    } finally {
      await f.close();
    }
  });
  it("stops a pending decision when driver control is withdrawn", async () => {
    let stopped = false;
    const f = await fixture({
      modelDelayMs: 1000,
      onModel: () => {
        setTimeout(() => {
          stopped = true;
        }, 10);
      },
    });
    try {
      const result = await runMinecraftPlay({ ...f.input, shouldStop: () => stopped });
      expect(result.outcome).toBe("stopped");
      expect(f.requests).toHaveLength(1);
      expect(f.actions).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  it("paces an empty world and ends the sitting after idleStopMs", async () => {
    const f = await fixture({ alone: true });
    try {
      const result = await runMinecraftPlay({
        ...f.input,
        budget: { ...f.input.budget, maxTurns: 100 },
        turnIntervalMs: 10,
        idleBackoffMs: 20,
        idleStopMs: 300,
      });
      expect(result.outcome).toBe("idle");
      expect(f.requests.length).toBeGreaterThanOrEqual(2);
      expect(f.requests.length).toBeLessThanOrEqual(6);
      expect((f.requests[1]?.at ?? 0) - (f.requests[0]?.at ?? 0)).toBeGreaterThanOrEqual(20);
    } finally {
      await f.close();
    }
  });
  it("reports repeated absence of observed progress as information", async () => {
    const f = await fixture();
    try {
      const events: string[] = [];
      const result = await runMinecraftPlay({
        ...f.input,
        budget: { ...f.input.budget, maxTurns: 6 },
        onNotable: (event) => {
          events.push(event.kind);
        },
      });
      expect(result.turnsTaken).toBe(6);
      expect(events).toEqual(["stuck"]);
    } finally {
      await f.close();
    }
  });
  it("reports an ended world and makes no decision or action", async () => {
    const f = await fixture({ mode: () => "disconnected" });
    try {
      const events: string[] = [];
      const result = await runMinecraftPlay({
        ...f.input,
        onNotable: (event) => {
          events.push(event.kind);
        },
      });
      expect(result.outcome).toBe("world_ended");
      expect(events).toEqual(["world_ended"]);
      expect(f.requests).toHaveLength(0);
      expect(f.actions).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  it("treats body unavailability during driver withdrawal as a normal stop", async () => {
    let stopped = false;
    const f = await fixture({
      mode: () => {
        stopped = true;
        throw new Error("Driver withdrawn");
      },
    });
    try {
      const events: string[] = [];
      const result = await runMinecraftPlay({
        ...f.input,
        shouldStop: () => stopped,
        onNotable: (event) => {
          events.push(event.kind);
        },
      });
      expect(result.outcome).toBe("stopped");
      expect(events).toEqual([]);
      expect(f.requests).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
});
