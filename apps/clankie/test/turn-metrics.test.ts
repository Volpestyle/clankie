import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationStore, OPERATOR_CONVERSATION_RETAINED_MAX } from "../src/captain/conversations.ts";
import {
  isMutatingTool,
  recordPiTurnEvent,
  sessionExecutionIdentity,
  tryAppendTurnSettled,
  TurnMetrics,
  TurnSettledLog,
  TurnSettledMetricsSchema,
  turnSettledLogPath,
} from "../src/captain/turn-metrics.ts";

/** The slice of a live pi session execution identity is read from. */
interface FakeSession {
  model: { id: string; provider: string } | undefined;
  thinkingLevel: string;
}

function session(model: string, provider: string, effort: string): FakeSession {
  return { model: { id: model, provider }, thinkingLevel: effort };
}

/** One finished assistant message, the only thing that reports usage. */
function assistantMessageEnd(totalTokens: number): {
  type: string;
  message: { role: string; usage: { totalTokens: number } };
} {
  return { type: "message_end", message: { role: "assistant", usage: { totalTokens } } };
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clankie-turn-metrics-"));
  roots.push(root);
  return root;
}

function collector(overrides: Partial<ConstructorParameters<typeof TurnMetrics>[0]> = {}): TurnMetrics {
  return new TurnMetrics({
    conversationId: "conv-1",
    lane: "operator",
    runId: "run-1",
    acceptedAt: "2026-08-26T12:00:00.000Z",
    contextTokensStart: 1200,
    ...overrides,
  });
}

describe("turn-settled metrics", () => {
  it("appends exactly one well-formed captain.turn.settled line for a completed turn", async () => {
    const root = await temporaryRoot();
    const log = new TurnSettledLog(turnSettledLogPath(root));
    const metrics = collector();
    recordPiTurnEvent(
      metrics,
      { type: "tool_execution_start", toolName: "read", args: { path: "secret.ts" } },
      new Date("2026-08-26T12:00:01.000Z"),
    );
    recordPiTurnEvent(
      metrics,
      { type: "tool_execution_start", toolName: "write", args: { path: "secret.ts", contents: "nope" } },
      new Date("2026-08-26T12:00:02.000Z"),
    );
    recordPiTurnEvent(metrics, { type: "tool_execution_end", toolName: "write" });

    log.append(metrics.finish("completed", new Date("2026-08-26T12:00:03.000Z"), 1400));
    const lines = (await readFile(log.path, "utf8")).split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    const parsed = TurnSettledMetricsSchema.parse(JSON.parse(lines[0]!));
    expect(parsed).toEqual({
      schemaVersion: 1,
      type: "captain.turn.settled",
      conversationId: "conv-1",
      lane: "operator",
      runId: "run-1",
      acceptedAt: "2026-08-26T12:00:00.000Z",
      completedAt: "2026-08-26T12:00:03.000Z",
      outcome: "completed",
      toolCount: { read: 1, write: 1 },
      firstMutatingAt: "2026-08-26T12:00:02.000Z",
      firstMutatingTool: "write",
      mutatingCount: 1,
      surveyToolCountBeforeFirstMutation: 1,
      contextTokensStart: 1200,
      contextTokensEnd: 1400,
    });
    // Nothing was reported, so usage is absent — never a zero that reads as free.
    expect(parsed.usage ?? undefined).toBeUndefined();
    expect(parsed.execution ?? undefined).toBeUndefined();
    expect(lines[0]).not.toContain("secret.ts");
    expect(lines[0]).not.toContain("nope");
    expect(lines[0]).not.toContain("contents");
  });

  it("logs outcome failed for a failed turn", async () => {
    const root = await temporaryRoot();
    const log = new TurnSettledLog(turnSettledLogPath(root));
    const metrics = collector();
    log.append(metrics.finish("failed", new Date("2026-08-26T12:00:04.000Z")));
    const parsed = TurnSettledMetricsSchema.parse(JSON.parse((await readFile(log.path, "utf8")).trim()));
    expect(parsed.outcome).toBe("failed");
    expect(parsed.failedAt).toBe("2026-08-26T12:00:04.000Z");
    expect(parsed.completedAt).toBeUndefined();
    expect(parsed.toolCount).toEqual({});
    expect(parsed.mutatingCount).toBe(0);
  });

  it("does not append a line for an absorbed steer", async () => {
    const root = await temporaryRoot();
    const log = new TurnSettledLog(turnSettledLogPath(root));
    tryAppendTurnSettled(log, undefined, "completed", new Date("2026-08-26T12:00:05.000Z"));
    expect(existsSync(log.path)).toBe(false);
  });

  it("survives ConversationStore conversation-directory prune", async () => {
    const root = await temporaryRoot();
    const conversations = join(root, "conversations");
    const log = new TurnSettledLog(turnSettledLogPath(root));
    log.append(collector().finish("completed", new Date("2026-08-26T12:00:06.000Z"), 100));
    const before = await readFile(log.path, "utf8");

    const pruned: string[] = [];
    const store = new ConversationStore(
      conversations,
      async () => undefined,
      (conversationId) => {
        pruned.push(conversationId);
      },
    );
    let oldest = "";
    for (let index = 0; index < OPERATOR_CONVERSATION_RETAINED_MAX; index += 1) {
      const result = await store.serve({
        op: "create",
        schemaVersion: 1,
        scope: { kind: "global" },
        title: `conversation ${index}`,
      });
      if (result.op !== "create") throw new Error("conversation was not created");
      if (index === 0) oldest = result.conversation.conversationId;
    }
    expect(pruned).toContain(oldest);
    expect(existsSync(join(conversations, oldest))).toBe(false);
    expect(await readFile(log.path, "utf8")).toBe(before);
    await store.close();
  });
});

describe("mutating tool classification", () => {
  it("treats write and edit as mutating and git status as inspection", () => {
    expect(isMutatingTool("write", { path: "a.ts" })).toBe(true);
    expect(isMutatingTool("edit", { path: "a.ts" })).toBe(true);
    expect(isMutatingTool("read", { path: "a.ts" })).toBe(false);
    expect(isMutatingTool("bash", { command: "git status" })).toBe(false);
    expect(isMutatingTool("bash", { command: "git --no-pager diff" })).toBe(false);
    expect(isMutatingTool("bash", { command: "git commit -am done" })).toBe(true);
    expect(isMutatingTool("bash", { command: "rm -rf src" })).toBe(true);
    expect(isMutatingTool("bash", { command: "git status && rm -rf src" })).toBe(false);
  });
});

describe("execution identity", () => {
  it("records the model, provider and effort the session actually ran", () => {
    expect(sessionExecutionIdentity(session("gpt-6-astra", "openai-codex", "high"))).toEqual({
      model: "gpt-6-astra",
      provider: "openai-codex",
      effort: "high",
    });
  });

  it("reports unknown rather than guessing when the session has no model yet", () => {
    expect(sessionExecutionIdentity({ model: undefined, thinkingLevel: "high" })).toBeUndefined();
    expect(sessionExecutionIdentity(session("gpt-6-astra", "openai-codex", ""))).toBeUndefined();
  });

  it("attributes a mid-conversation model switch to the turn that executes it", () => {
    // One live session; `/model` and `/effort` swap what it runs between turns.
    const live = session("gpt-6-astra", "openai-codex", "high");
    const first = collector({ runId: "run-astra" });
    first.recordExecution(sessionExecutionIdentity(live));
    const before = first.finish("completed", new Date("2026-08-26T12:00:03.000Z"));

    live.model = { id: "claude-sonnet-5", provider: "anthropic" };
    live.thinkingLevel = "medium";
    const second = collector({ runId: "run-terra" });
    second.recordExecution(sessionExecutionIdentity(live));
    const after = second.finish("completed", new Date("2026-08-26T12:00:09.000Z"));

    expect(before.execution).toEqual({ model: "gpt-6-astra", provider: "openai-codex", effort: "high" });
    expect(after.execution).toEqual({ model: "claude-sonnet-5", provider: "anthropic", effort: "medium" });
  });

  it("names what ran a failed turn and an interrupted one", () => {
    const failed = collector();
    failed.recordExecution(sessionExecutionIdentity(session("gpt-6-astra", "openai-codex", "high")));
    const interrupted = collector();
    interrupted.recordExecution(sessionExecutionIdentity(session("gpt-6-astra", "openai-codex", "high")));

    const failedRow = failed.finish("failed", new Date("2026-08-26T12:00:04.000Z"));
    const interruptedRow = interrupted.finish("interrupted", new Date("2026-08-26T12:00:05.000Z"));
    expect(failedRow.execution?.model).toBe("gpt-6-astra");
    expect(interruptedRow.execution?.effort).toBe("high");
    expect(interruptedRow.outcome).toBe("interrupted");
  });
});

describe("reported usage", () => {
  it("sums every assistant report across a multi-round turn and counts the reports", () => {
    const metrics = collector();
    recordPiTurnEvent(metrics, assistantMessageEnd(1_200));
    recordPiTurnEvent(metrics, { type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } });
    recordPiTurnEvent(metrics, assistantMessageEnd(900));
    recordPiTurnEvent(metrics, assistantMessageEnd(4));
    const row = metrics.finish("completed", new Date("2026-08-26T12:00:07.000Z"), 4_000);
    expect(row.usage).toEqual({ totalTokens: 2_104, reports: 3 });
    // Context occupancy stays its own field and never becomes usage.
    expect(row.contextTokensEnd).toBe(4_000);
  });

  it("ignores a user message and an assistant message that reported nothing", () => {
    const metrics = collector();
    recordPiTurnEvent(metrics, {
      type: "message_end",
      message: { role: "user", usage: { totalTokens: 9 } },
    });
    recordPiTurnEvent(metrics, { type: "message_end", message: { role: "assistant" } });
    const row = metrics.finish("completed", new Date("2026-08-26T12:00:08.000Z"));
    expect(row.usage ?? undefined).toBeUndefined();
  });
});

describe("reading recent turn metrics", () => {
  async function seeded(): Promise<TurnSettledLog> {
    const log = new TurnSettledLog(turnSettledLogPath(await temporaryRoot()));
    for (let index = 0; index < 5; index += 1) {
      const metrics = collector({ runId: `run-${index}` });
      metrics.recordExecution({ model: "gpt-6-astra", provider: "openai-codex", effort: "high" });
      metrics.recordReportedUsage(100 * (index + 1));
      log.append(metrics.finish("completed", new Date(`2026-08-26T12:0${index}:00.000Z`)));
    }
    return log;
  }

  it("answers newest first, bounded by limit", async () => {
    const log = await seeded();
    const items = await log.read({ limit: 2 });
    expect(items.map((item) => item.runId)).toEqual(["run-4", "run-3"]);
    expect(items[0]?.usage).toEqual({ totalTokens: 500, reports: 1 });
    expect(items[0]?.execution).toEqual({
      model: "gpt-6-astra",
      provider: "openai-codex",
      effort: "high",
    });
  });

  it("narrows to one run", async () => {
    const log = await seeded();
    const items = await log.read({ runId: "run-2" });
    expect(items.map((item) => item.runId)).toEqual(["run-2"]);
  });

  it("clamps the limit into 1…100 and defaults to 20", async () => {
    const log = await seeded();
    expect(await log.read({ limit: 0 })).toHaveLength(1);
    expect(await log.read({ limit: 10_000 })).toHaveLength(5);
    expect(await log.read({ limit: Number.NaN })).toHaveLength(5);
    expect(await log.read()).toHaveLength(5);
  });

  it("reads a row written before execution capture with explicit unknowns", async () => {
    const root = await temporaryRoot();
    const path = turnSettledLogPath(root);
    // A legacy line, exactly as VUH-1022 wrote it: no execution, no usage.
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: 1,
        type: "captain.turn.settled",
        conversationId: "conv-legacy",
        lane: "operator",
        runId: "run-legacy",
        acceptedAt: "2026-08-01T12:00:00.000Z",
        completedAt: "2026-08-01T12:00:03.000Z",
        outcome: "completed",
        toolCount: { read: 2 },
        mutatingCount: 0,
        contextTokensStart: 1_000,
        contextTokensEnd: 1_400,
      })}\nnot json\n`,
      "utf8",
    );
    const items = await new TurnSettledLog(path).read();
    expect(items).toHaveLength(1);
    expect(items[0]?.execution).toBeNull();
    expect(items[0]?.usage).toBeNull();
    expect(items[0]?.contextTokensEnd).toBe(1_400);
  });

  it("is empty rather than failing when nothing has settled yet", async () => {
    const log = new TurnSettledLog(turnSettledLogPath(await temporaryRoot()));
    expect(await log.read()).toEqual([]);
  });
});
