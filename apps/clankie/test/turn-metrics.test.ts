import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationStore, OPERATOR_CONVERSATION_RETAINED_MAX } from "../src/captain/conversations.ts";
import {
  isMutatingTool,
  recordPiToolStart,
  tryAppendTurnSettled,
  TurnMetrics,
  TurnSettledLog,
  TurnSettledMetricsSchema,
  turnSettledLogPath,
} from "../src/captain/turn-metrics.ts";

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
    recordPiToolStart(
      metrics,
      { type: "tool_execution_start", toolName: "read", args: { path: "secret.ts" } },
      new Date("2026-08-26T12:00:01.000Z"),
    );
    recordPiToolStart(
      metrics,
      { type: "tool_execution_start", toolName: "write", args: { path: "secret.ts", contents: "nope" } },
      new Date("2026-08-26T12:00:02.000Z"),
    );
    recordPiToolStart(metrics, { type: "tool_execution_end", toolName: "write" });

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
