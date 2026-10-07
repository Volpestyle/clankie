import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { SeatQuestion, SeatRef } from "@clankie/agent-hosts";
import type { FleetSeatHook } from "@clankie/protocol";
import { ClaudeHookQuestions } from "../src/captain/claude-hook-questions.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function journal(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "claude-hook-questions-"));
  roots.push(root);
  return join(root, "used.json");
}
const ref: SeatRef = { harness: "claude", paneId: "worker-pane", sessionId: "native-session" };
const ask: FleetSeatHook = {
  schemaVersion: 1,
  sessionId: ref.sessionId,
  event: "PreToolUse",
  toolName: "AskUserQuestion",
  toolUseId: "toolu_framework",
  toolInput: {
    questions: [
      {
        question: "Which framework?",
        header: "Framework",
        options: [
          { label: "React", description: "Component library" },
          { label: "Vue", description: "Progressive framework" },
        ],
        multiSelect: false,
      },
    ],
  },
};

it("translates documented Claude input through question IDs and persists consumption across restart", async () => {
  const path = await journal();
  const registry = new ClaudeHookQuestions(path);
  let publish!: (question: SeatQuestion) => void;
  const published = new Promise<SeatQuestion>((resolve) => {
    publish = resolve;
  });
  const hookResult = registry.open(ref, ask, async (q) => publish(q));
  const question = await published;
  const answer = { requestId: question.requestId, answers: { q0: { answers: ["React"] } } };
  expect(registry.pending(ref, question.requestId)?.questions[0]?.options?.[0]?.label).toBe("React");
  expect(await registry.answer({ ...ref, sessionId: "replacement-session" }, answer)).toMatchObject({
    outcome: "refused",
  });
  expect(
    await registry.answer(ref, { ...answer, answers: { incorrect: { answers: ["React"] } } }),
  ).toMatchObject({ outcome: "refused" });
  const delivered = registry.answer(ref, answer);
  expect(await hookResult).toEqual({
    requestId: question.requestId,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...ask.toolInput, answers: { "Which framework?": "React" } },
    },
  });
  expect(registry.acknowledge({ ...ref, sessionId: "replacement-session" }, String(question.requestId))).toBe(
    false,
  );
  expect(registry.acknowledge(ref, String(question.requestId))).toBe(true);
  expect(await delivered).toEqual({ outcome: "answered", deliveryStage: "responded" });
  expect(registry.acknowledge(ref, String(question.requestId))).toBe(false);
  expect(await registry.answer(ref, answer)).toMatchObject({ outcome: "refused" });
  const disk = await readFile(path, "utf8");
  expect(JSON.parse(disk)).toEqual([question.requestId]);
  expect(disk).not.toContain("React");
  const restarted = new ClaudeHookQuestions(path);
  expect(
    await restarted.open(ref, ask, async () => {
      throw new Error("Replay must not publish");
    }),
  ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
});

it("consumes permission denials and refuses freeform approval labels", async () => {
  const registry = new ClaudeHookQuestions(await journal());
  let publish!: (q: SeatQuestion) => void;
  const published = new Promise<SeatQuestion>((resolve) => {
    publish = resolve;
  });
  const result = registry.open(
    ref,
    {
      ...ask,
      event: "PermissionRequest",
      toolName: "Bash",
      toolInput: { command: "git push" },
      toolUseId: "permission-invocation",
    },
    async (q) => publish(q),
  );
  const q = await published;
  expect(
    await registry.answer(ref, { requestId: q.requestId, answers: { q0: { answers: ["Sure"] } } }),
  ).toMatchObject({ outcome: "refused" });
  const delivered = registry.answer(ref, { requestId: q.requestId, answers: { q0: { answers: ["Deny"] } } });
  expect(await result).toMatchObject({
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny" } },
  });
  expect(registry.acknowledge(ref, String(q.requestId))).toBe(true);
  expect(await delivered).toMatchObject({ outcome: "answered" });
});

it("reports unconfirmed consumption when stdout has no receipt and refuses retries after restart", async () => {
  const path = await journal();
  const registry = new ClaudeHookQuestions(path, 1000, 20);
  let publish!: (q: SeatQuestion) => void;
  const published = new Promise<SeatQuestion>((resolve) => {
    publish = resolve;
  });
  const result = registry.open(ref, ask, async (q) => publish(q));
  const q = await published;
  const answer = { requestId: q.requestId, answers: { q0: { answers: ["React"] } } };
  const delivered = registry.answer(ref, answer);
  expect((await result).requestId).toBe(q.requestId);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(await delivered).toMatchObject({ outcome: "unconfirmed" });
  expect(registry.acknowledge(ref, String(q.requestId))).toBe(false);
  expect(await registry.answer(ref, answer)).toMatchObject({ outcome: "refused" });
  const restarted = new ClaudeHookQuestions(path);
  expect(
    await restarted.open(ref, ask, async () => {
      throw new Error("Replay must not publish");
    }),
  ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
});

it("refuses the second concurrent answer and denies an expired or aborted hook", async () => {
  const registry = new ClaudeHookQuestions(await journal(), 25);
  let publish!: (q: SeatQuestion) => void;
  const published = new Promise<SeatQuestion>((resolve) => {
    publish = resolve;
  });
  const controller = new AbortController();
  const result = registry.open(ref, ask, async (q) => publish(q), controller.signal);
  const q = await published;
  let release!: () => void;
  const guard = new Promise<void>((resolve) => {
    release = resolve;
  });
  const answer = { requestId: q.requestId, answers: { q0: { answers: ["Custom framework"] } } };
  const first = registry.answer(ref, answer, () => guard);
  expect(await registry.answer(ref, answer)).toMatchObject({ outcome: "refused" });
  controller.abort();
  release();
  expect(await first).toMatchObject({ outcome: "refused" });
  expect(await result).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  const expired = registry.open(ref, { ...ask, toolUseId: "toolu_expiring" }, async () => {});
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(await expired).toMatchObject({
    hookSpecificOutput: {
      permissionDecision: "deny",
      permissionDecisionReason: "claude_hook_question_expired",
    },
  });
});
