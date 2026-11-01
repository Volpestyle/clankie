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

async function fixture(results: ("accepted" | "deferred")[], kind: "ask" | "permission" = "ask") {
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
  let failReads = 0;
  const runner: HerdrWatchRunner = {
    get: async () => agent,
    resolveTerminal: async () => {
      if (failReads > 0) {
        failReads--;
        throw new Error("herdr socket unavailable");
      }
      return agent;
    },
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
  let leadMayAnswer = true;
  const escalations: string[] = [];
  let failEscalations = 0;
  store.permissionLeadAllowed = async () => leadMayAnswer;
  store.questionGate = async () => "allow";
  store.escalateQuestion = async (_owner, _agent, question) => {
    if (failEscalations > 0) {
      failEscalations--;
      throw new Error("owner ask unavailable");
    }
    escalations.push(String(question.requestId));
  };
  await store.adoptSeat(agent.terminalId, lead("lead"));
  cleanups.push(async () => {
    registry.cancel(ref);
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const permission: FleetSeatHook = {
    schemaVersion: 1,
    sessionId: ref.sessionId,
    event: "PermissionRequest",
    toolUseId: randomUUID(),
    toolName: "Read",
    toolInput: { file_path: join(root, "notes.md") },
  };
  const ask: FleetSeatHook = {
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
  const output = registry.open(
    ref,
    kind === "ask" ? ask : permission,
    async (q) => {
      asked(q);
      await store.forwardNativeQuestion(ref, q);
    },
    undefined,
    root,
  );
  return {
    ref,
    registry,
    store,
    wakes,
    escalations,
    output,
    question: await question,
    failNextReads: (count: number) => {
      failReads = count;
    },
    leadCannotAnswer: () => {
      leadMayAnswer = false;
    },
    failNextEscalations: (count: number) => {
      failEscalations = count;
    },
  };
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

it("keeps reminding after a reminder round fails to read the worker", async () => {
  const f = await fixture([]);
  await until(() => f.wakes.length === 1);
  f.failNextReads(1);
  await until(() => f.wakes.some((wake) => wake.text.startsWith("Still open")));
});

it("sends the question to the owner once its lead can no longer answer it", async () => {
  const f = await fixture([], "permission");
  await until(() => f.wakes.length === 1);
  expect(f.wakes[0]!.text).toContain("asks its lead a native harness question");
  f.leadCannotAnswer();
  await until(() => f.escalations.length === 1);
  expect(f.escalations).toEqual([String(f.question.requestId)]);
  await until(() => f.wakes.some((wake) => wake.text.includes("escalated question")));
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(f.wakes.filter((wake) => wake.text.startsWith("Still open"))).toEqual([]);
  expect(f.escalations).toHaveLength(1);
});

it("tries the owner again when sending them the question fails", async () => {
  const f = await fixture([], "permission");
  await until(() => f.wakes.length === 1);
  f.failNextEscalations(1);
  f.leadCannotAnswer();
  await until(() => f.escalations.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(f.escalations).toHaveLength(1);
  expect(f.wakes.filter((wake) => wake.text.startsWith("Still open"))).toEqual([]);
});
