import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { SeatQuestion, SeatRef } from "@clankie/agent-hosts";
import type { FleetSeatHook } from "@clankie/protocol";
import { ClaudeHookQuestions } from "../src/captain/claude-hook-questions.ts";
import { createClaudeWorkerSeatAdapter, SeatHookLog } from "../src/captain/claude-worker-seat.ts";
import {
  HerdrWatchStore,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "../src/captain/herdr-watch.ts";
import type { ConversationAuthority } from "../src/captain/conversation-owner.ts";

// ADR 0322: an open worker question keeps reaching whoever leads its hire, and
// the first answer wins.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function lead(conversationId: string): ConversationAuthority {
  return { owner: { conversationId }, current: () => true, authorize: async () => true };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(results: ("accepted" | "deferred")[]) {
  const root = mkdtempSync(join(tmpdir(), "open-question-reminders-"));
  const ref: SeatRef = { harness: "claude", paneId: "worker-pane", sessionId: randomUUID() };
  const agent: HerdrAgentSnapshot = {
    paneId: ref.paneId,
    terminalId: "worker-seat",
    agent: "claude",
    status: "blocked",
    title: "worker",
    workingDirectory: root,
    session: { source: "herdr:claude", kind: "id", value: ref.sessionId },
  };
  const registry = new ClaudeHookQuestions(join(root, "used.json"), 5000, 100);
  const runner: HerdrWatchRunner = {
    get: async () => agent,
    resolveTerminal: async () => agent,
    wait: async () => agent,
    transcript: async () => undefined,
  };
  const hooks = new SeatHookLog(join(root, "hooks.json"));
  hooks.record(ref.paneId, { schemaVersion: 1, event: "SessionStart", sessionId: ref.sessionId });
  const adapter = createClaudeWorkerSeatAdapter({
    consent: async () => ({ approved: true }),
    hooks,
    hookQuestions: registry,
    agent: async () => agent,
    transcript: async () => undefined,
    mailbox: { bound: () => true, deliver: async () => false },
  });
  const store = new HerdrWatchStore(join(root, "watches.json"), {
    runner,
    seatAdapters: [adapter],
    questionReminders: { retryMs: 30, remindMs: 120, windowMs: 2000 },
  });
  const wakes: { conversationId: string; text: string }[] = [];
  store.start(async (conversationId, text) => {
    wakes.push({ conversationId, text });
    return results.shift() ?? "accepted";
  });
  await store.adoptSeat(agent.terminalId, lead("lead"));
  cleanups.push(async () => {
    registry.cancel(ref);
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const hook: FleetSeatHook = {
    schemaVersion: 1,
    sessionId: ref.sessionId,
    event: "PreToolUse",
    toolName: "AskUserQuestion",
    toolUseId: randomUUID(),
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
  let asked!: (question: SeatQuestion) => void;
  const question = new Promise<SeatQuestion>((resolve) => {
    asked = resolve;
  });
  const output = registry.open(ref, hook, async (q) => {
    asked(q);
    await store.forwardNativeQuestion(ref, q);
  });
  return { ref, registry, store, wakes, output, question: await question };
}

it("retries a question no lead took and repeats it until a lead answers", async () => {
  const f = await fixture(["deferred"]);
  await until(() => f.wakes.length >= 3);
  expect(f.wakes.map((wake) => wake.conversationId)).toEqual(["lead", "lead", "lead"]);
  expect(f.wakes[0]!.text).toContain("asks its lead a native harness question");
  for (const wake of f.wakes.slice(1)) {
    expect(wake.text).toMatch(/^Still open: worker worker-seat's question /);
    expect(wake.text).toContain(String(f.question.requestId));
  }
  const answer = { requestId: f.question.requestId, answers: { q0: { answers: ["Vue"] } } };
  const delivered = f.store.answerSeatQuestion("worker-seat", answer, lead("lead"));
  const output = await f.output;
  expect(output.hookSpecificOutput).toMatchObject({ permissionDecision: "allow" });
  f.registry.acknowledge(f.ref, output.requestId!);
  expect(await delivered).toMatchObject({ outcome: "delivered" });
  const told = f.wakes.length;
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(f.wakes.slice(told).filter((wake) => wake.text.startsWith("Still open"))).toEqual([]);
});

it("tells a second lead that the first answer won", async () => {
  const f = await fixture([]);
  const answer = { requestId: f.question.requestId, answers: { q0: { answers: ["React"] } } };
  const first = f.store.answerSeatQuestion("worker-seat", answer, lead("lead"));
  const output = await f.output;
  f.registry.acknowledge(f.ref, output.requestId!);
  expect(await first).toMatchObject({ outcome: "delivered" });
  const second = await f.store.answerSeatQuestion(
    "worker-seat",
    { ...answer, answers: { q0: { answers: ["Vue"] } } },
    lead("grok"),
  );
  expect(second.outcome).not.toBe("delivered");
  expect(second.detail).toContain("native_question_already_answered");
});
