import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  OperatorConversationServiceResultSchema,
  ConversationDecisionPolicySchema,
  type ConversationQuestionResult,
} from "@clankie/protocol";
import { ConversationStore, type ConversationTurnContext } from "../src/captain/conversations.ts";
import {
  QuestionDraftSchema,
  SAFE_DECISION_DEFAULT,
  type QuestionAuthority,
  type QuestionRecord,
} from "../src/captain/conversation-questions.ts";
import { questionTools } from "../src/captain/question-tools.ts";

const owner: QuestionAuthority = {
  principal: { kind: "operator", id: "deadline-owner" },
  current: () => true,
  authorize: async () => true,
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const draft = (deadlineAt = new Date(Date.now() + 60_000).toISOString()) => ({
  purpose: "decision" as const,
  kind: "choice" as const,
  prompt: "Which route should the lead take?",
  options: [{ label: "Continue the current route" }, { label: "Wait" }],
  recommendation: "Continue the current route",
  waitingOn: "Choosing the next authorized task",
  defaultAction: "Continue the current authorized route and report its outcome.",
  deadlineAt,
  allowFreeform: false,
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "decision-deadline-"));
  const runs: Array<{ message: string; context: ConversationTurnContext }> = [];
  const stores: ConversationStore[] = [];
  const open = () => {
    const store = new ConversationStore(root, async (_id, message, _publish, context) => {
      runs.push({ message, context });
    });
    stores.push(store);
    return store;
  };
  cleanups.push(async () => {
    for (const store of stores) await store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, runs, open, store: open() };
}
async function read(store: ConversationStore, requestId: string, conversationId = "global-default") {
  const response = OperatorConversationServiceResultSchema.parse(
    await store.serve({ op: "input_get", schemaVersion: 1, conversationId, requestId }, owner),
  );
  if (response.op !== "input_get" || !response.result.question) throw new Error("Missing ask");
  return response.result;
}
async function mail(store: ConversationStore) {
  const response = OperatorConversationServiceResultSchema.parse(
    await store.serve({ op: "owner_update_list", schemaVersion: 1 }, owner),
  );
  if (response.op !== "owner_update_list") throw new Error("Missing mailbox");
  return response.result.updates;
}
function rewrite(root: string, change: (record: QuestionRecord) => void, conversationId = "global-default") {
  const path = join(root, conversationId, "meta.json");
  const meta = JSON.parse(readFileSync(path, "utf8"));
  change(meta.questions.records[0]);
  writeFileSync(path, JSON.stringify(meta));
}

it("publishes immutable decision defaults through the real ask tool without changing strict public receipts", async () => {
  const f = fixture();
  const tool = questionTools({
    requestQuestion: (d) => f.store.requestSurfaceQuestion("global-default", d, { current: () => true }),
  }).find((t) => t.name === "request_user_input")!;
  const input = draft();
  const first = await tool.execute("ask-default", input, undefined, undefined, {} as never);
  const again = await tool.execute("ask-default", input, undefined, undefined, {} as never);
  expect(again.details).toMatchObject({
    question: (first.details as { question: unknown }).question,
    reason: "already_pending",
  });
  const listed = await f.store.serve({ op: "input_list", schemaVersion: 1 }, owner);
  if (listed.op !== "input_list") throw new Error("Missing list");
  const q = listed.result.questions[0]!.question!;
  expect(q.steps).toEqual([`Default if unanswered: ${input.defaultAction}`, `Deadline: ${input.deadlineAt}`]);
  expect(q).not.toHaveProperty("defaultAction");
  expect(q).not.toHaveProperty("decisionPolicy");
  OperatorConversationServiceResultSchema.parse(listed);
  const changed = await f.store.requestSurfaceQuestion(
    "global-default",
    { ...input, defaultAction: "Wait and continue unrelated authorized work." },
    { current: () => true },
  );
  expect(changed.question!.requestId).not.toBe(q.requestId);
  const { defaultAction: _default, deadlineAt: _deadline, ...legacy } = input;
  const old = await f.store.requestSurfaceQuestion(
    "global-default",
    { ...legacy, prompt: "A legacy decision" },
    { current: () => true },
  );
  expect(old.question!.steps![0]).toContain(SAFE_DECISION_DEFAULT);
  expect(
    Date.parse(old.question!.steps![1]!.slice("Deadline: ".length)) - Date.parse(old.question!.createdAt),
  ).toBe(86_400_000);
  expect(
    (
      await f.store.requestSurfaceQuestion(
        "global-default",
        { ...legacy, prompt: "A legacy decision" },
        { current: () => true },
      )
    ).question!.requestId,
  ).toBe(old.question!.requestId);
});

it("expires on the real timer once, persists one owner notice, and never attributes the default to the owner", async () => {
  const f = fixture();
  const input = draft(new Date(Date.now() + 100).toISOString());
  const first = await f.store.requestSurfaceQuestion("global-default", input, {
    current: () => true,
    publicationId: "deadline-one",
  });
  await expect.poll(() => f.runs.length, { timeout: 10_000 }).toBe(1);
  const resolved = await read(f.store, first.question!.requestId);
  expect(resolved.question).toMatchObject({
    status: "cancelled",
    reason: "decision_deadline_elapsed",
    resolvedBy: { kind: "service", id: "clankie" },
  });
  expect(resolved.question).not.toHaveProperty("answer");
  expect(f.runs[0]!.message).toContain(input.defaultAction);
  expect(f.runs[0]!.message).toContain("not an owner answer");
  expect(f.runs[0]!.context.ownerAuthority).toBeUndefined();
  expect(f.runs[0]!.context.inputAnswer).toBeUndefined();
  expect(f.runs[0]!.context.origin).toBe("wake");
  const late = await f.store.serve(
    {
      op: "input_answer",
      schemaVersion: 1,
      conversationId: "global-default",
      requestId: first.question!.requestId,
      incarnationId: first.question!.incarnationId,
      expectedRevision: first.revision!,
      answer: { kind: "choice", optionId: first.question!.options[0]!.optionId },
    },
    owner,
  );
  expect(late).toMatchObject({ result: { status: "resolved", question: { status: "cancelled" } } });
  const notice = await mail(f.store);
  expect(notice).toHaveLength(1);
  expect(notice[0]!.body).toContain(input.defaultAction);
  await f.store.close();
  const restarted = f.open();
  expect(await mail(restarted)).toEqual(notice);
  expect((await read(restarted, first.question!.requestId)).question!.status).toBe("cancelled");
  expect(f.runs).toHaveLength(1);
  const replay = await restarted.requestSurfaceQuestion("global-default", input, {
    current: () => true,
    publicationId: "deadline-one",
  });
  expect(replay.question!.requestId).toBe(first.question!.requestId);
  const events = readFileSync(join(f.root, "global-default", "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.filter((e) => e.type === "input_resolved")).toMatchObject([{ outcome: "cancelled" }]);
  expect(events.filter((e) => e.type === "message" && (e.ownerOrigin || e.answerReceipt))).toEqual([]);
});

it("migrates a 30-hour unanswered legacy decision and wakes its source soon after restart without a mailbox read", async () => {
  const f = fixture();
  const first = await f.store.requestSurfaceQuestion("global-default", draft(), { current: () => true });
  await f.store.close();
  rewrite(f.root, (r) => {
    delete r.decisionPolicy;
    delete r.question.steps;
    r.question.createdAt = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
  });
  const restarted = f.open();
  await expect.poll(() => f.runs.length, { timeout: 10_000 }).toBe(1);
  expect(f.runs[0]!.message).toContain(SAFE_DECISION_DEFAULT);
  const q = (await read(restarted, first.question!.requestId)).question!;
  expect(q.status).toBe("cancelled");
  expect(q.steps![0]).toContain(SAFE_DECISION_DEFAULT);
  expect(await mail(restarted)).toHaveLength(1);
  await restarted.close();
  const twice = f.open();
  await read(twice, first.question!.requestId);
  expect(f.runs).toHaveLength(1);
  expect(await mail(twice)).toHaveLength(1);
});

it("keeps an owner answer authoritative when its deadline later passes across restart", async () => {
  const f = fixture();
  const first = await f.store.requestSurfaceQuestion("global-default", draft(), { current: () => true });
  const answered = await f.store.serve(
    {
      op: "input_answer",
      schemaVersion: 1,
      conversationId: "global-default",
      requestId: first.question!.requestId,
      incarnationId: first.question!.incarnationId,
      expectedRevision: first.revision!,
      answer: { kind: "choice", optionId: first.question!.options[1]!.optionId },
    },
    owner,
  );
  if (answered.op !== "input_answer") throw new Error("Missing answer");
  await f.store.awaitRun(answered.result.question!.continuation!.runId);
  await f.store.close();
  // Persisted answered-then-overdue case; no mocked clock or scheduler.
  rewrite(f.root, (r) => {
    r.decisionPolicy!.deadlineAt = "2026-01-01T00:00:00.000Z";
    r.question.steps![r.question.steps!.length - 1] = `Deadline: ${r.decisionPolicy!.deadlineAt}`;
  });
  const restarted = f.open();
  expect((await read(restarted, first.question!.requestId)).question).toMatchObject({
    status: "submitted",
    resolvedBy: owner.principal,
    answer: { kind: "choice", optionId: first.question!.options[1]!.optionId },
  });
  expect(f.runs).toHaveLength(1);
  expect(f.runs[0]!.context.ownerAuthority).toBe(owner);
  expect(await mail(restarted)).toEqual([]);
});

it("never defaults an approval, owner gate or native worker question, and rejects partial or authority-bearing policies", async () => {
  const f = fixture();
  f.store.questionGate = async () => true;
  const { defaultAction: _default, deadlineAt: _deadline, ...base } = draft();
  const gates = [];
  for (const purpose of ["approval", "gate"] as const) {
    const asked = await f.store.requestSurfaceQuestion(
      "global-default",
      { ...base, purpose, gate: "spend" },
      { current: () => true },
    );
    gates.push(asked.question!.requestId);
    await expect(
      f.store.requestSurfaceQuestion(
        "global-default",
        { ...draft(), purpose, gate: "spend" },
        { current: () => true },
      ),
    ).rejects.toThrow();
  }
  f.store.prepareWorkerQuestion = async () => ({
    seatId: "worker",
    requestId: 42,
    sessionId: "native",
    questions: [{ id: "q", question: "Approve spending?" }],
  });
  const worker = await f.store.requestSurfaceQuestion(
    "global-default",
    { ...base, workerQuestion: { seatId: "worker", requestId: 42 } },
    { current: () => true },
  );
  gates.push(worker.question!.requestId);
  await f.store.close();
  const path = join(f.root, "global-default", "meta.json");
  const meta = JSON.parse(readFileSync(path, "utf8"));
  for (const r of meta.questions.records) {
    r.question.createdAt = "2026-01-01T00:00:00.000Z";
    expect(r.decisionPolicy).toBeUndefined();
  }
  writeFileSync(path, JSON.stringify(meta));
  const restarted = f.open();
  for (const id of gates) expect((await read(restarted, id)).question!.status).toBe("pending");
  expect(f.runs).toEqual([]);
  expect(await mail(restarted)).toEqual([]);
  expect(QuestionDraftSchema.safeParse({ ...base, defaultAction: "Wait" }).success).toBe(false);
  expect(QuestionDraftSchema.safeParse({ ...base, deadlineAt: new Date().toISOString() }).success).toBe(
    false,
  );
  expect(QuestionDraftSchema.safeParse({ ...draft(), gate: "money" }).success).toBe(false);
  expect(
    ConversationDecisionPolicySchema.safeParse({ defaultAction: "Wait", deadlineAt: "tomorrow" }).success,
  ).toBe(false);
});

it("retains the ask when durable owner notification fails, then reconciles one expiry after storage recovers", async () => {
  const f = fixture();
  const first = await f.store.requestSurfaceQuestion("global-default", draft(), { current: () => true });
  await f.store.close();
  rewrite(f.root, (r) => {
    r.decisionPolicy!.deadlineAt = "2026-01-01T00:00:00.000Z";
    r.question.steps![r.question.steps!.length - 1] = `Deadline: ${r.decisionPolicy!.deadlineAt}`;
  });
  const restarted = f.open();
  const path = join(f.root, "owner-updates.json");
  mkdirSync(path);
  await expect(
    restarted.serve(
      {
        op: "input_get",
        schemaVersion: 1,
        conversationId: "global-default",
        requestId: first.question!.requestId,
      },
      owner,
    ),
  ).rejects.toThrow();
  expect(f.runs).toEqual([]);
  expect(
    JSON.parse(readFileSync(join(f.root, "global-default", "meta.json"), "utf8")).questions.records[0]
      .question.status,
  ).toBe("pending");
  rmSync(path, { recursive: true });
  await expect.poll(() => f.runs.length, { timeout: 10_000 }).toBe(1);
  expect((await read(restarted, first.question!.requestId)).question!.status).toBe("cancelled");
  expect(await mail(restarted)).toHaveLength(1);
});

it("reconciles committed owner mail when the atomic expiry acceptance cannot commit", async () => {
  const f = fixture();
  const first = await f.store.requestSurfaceQuestion("global-default", draft(), { current: () => true });
  await f.store.close();
  rewrite(f.root, (r) => {
    r.decisionPolicy!.deadlineAt = "2026-01-01T00:00:00.000Z";
    r.question.steps![r.question.steps!.length - 1] = `Deadline: ${r.decisionPolicy!.deadlineAt}`;
  });
  const restarted = f.open();
  const path = join(f.root, "global-default", "meta.json");
  const original = readFileSync(path, "utf8");
  rmSync(path);
  mkdirSync(path);
  await expect(
    restarted.serve(
      {
        op: "input_get",
        schemaVersion: 1,
        conversationId: "global-default",
        requestId: first.question!.requestId,
      },
      owner,
    ),
  ).rejects.toThrow();
  const notice = await mail(restarted);
  expect(notice).toHaveLength(1);
  expect(f.runs).toEqual([]);
  rmSync(path, { recursive: true });
  writeFileSync(path, original);
  await expect.poll(() => f.runs.length, { timeout: 10_000 }).toBe(1);
  expect(await mail(restarted)).toEqual(notice);
  expect((await read(restarted, first.question!.requestId)).question!.status).toBe("cancelled");
  await restarted.close();
  const twice = f.open();
  await read(twice, first.question!.requestId);
  expect(await mail(twice)).toEqual(notice);
  expect(f.runs).toHaveLength(1);
});

it("leaves expiry to the replacement store after closing the old service instance", async () => {
  const f = fixture();
  const deadlineAt = new Date(Date.now() + 100).toISOString();
  const first = await f.store.requestSurfaceQuestion("global-default", draft(deadlineAt), {
    current: () => true,
  });
  await f.store.close();
  await expect.poll(() => Date.now() >= Date.parse(deadlineAt), { timeout: 10_000 }).toBe(true);
  expect((await read(f.store, first.question!.requestId)).question!.status).toBe("pending");
  expect(f.runs).toEqual([]);
  const restarted = f.open();
  await expect.poll(() => f.runs.length, { timeout: 10_000 }).toBe(1);
  expect((await read(restarted, first.question!.requestId)).question!.status).toBe("cancelled");
  expect(await mail(restarted)).toHaveLength(1);
});

it("isolates a refused overdue source so another real conversation still takes its default", async () => {
  const f = fixture();
  const workspace = join(f.root, "workspace");
  mkdirSync(workspace);
  const created = await f.store.serve({
    op: "create",
    schemaVersion: 1,
    scope: { kind: "workspace", workspaceId: workspace },
    title: "Independent deadline",
  });
  if (created.op !== "create") throw new Error("Missing conversation");
  const workspaceId = created.conversation.conversationId;
  const asks = new Map<string, ConversationQuestionResult>();
  for (const id of ["global-default", workspaceId])
    asks.set(id, await f.store.requestSurfaceQuestion(id, draft(), { current: () => true }));
  await f.store.close();
  // Use the store's real disk load order, so the refused source is visited first.
  const ids = readdirSync(f.root).filter((id) => asks.has(id));
  const firstId = ids[0]!,
    otherId = ids[1]!;
  const first = asks.get(firstId)!,
    other = asks.get(otherId)!;
  for (const id of ids)
    rewrite(
      f.root,
      (r) => {
        r.decisionPolicy!.deadlineAt = "2026-01-01T00:00:00.000Z";
        r.question.steps![r.question.steps!.length - 1] = `Deadline: ${r.decisionPolicy!.deadlineAt}`;
      },
      id,
    );
  const restarted = f.open();
  // A real filesystem refusal after mail commits; no mocked context or writer.
  const path = join(f.root, firstId, "meta.json");
  const original = readFileSync(path, "utf8");
  rmSync(path);
  mkdirSync(path);
  await expect.poll(() => f.runs.length, { timeout: 10_000 }).toBe(1);
  expect(f.runs[0]!.message).toContain(other.question!.requestId);
  expect((await read(restarted, other.question!.requestId, otherId)).question!.status).toBe("cancelled");
  await expect(read(restarted, first.question!.requestId, firstId)).rejects.toThrow();
  expect(await mail(restarted)).toHaveLength(2);
  rmSync(path, { recursive: true });
  writeFileSync(path, original);
  await read(restarted, first.question!.requestId, firstId);
  await expect.poll(() => f.runs.length, { timeout: 10_000 }).toBe(2);
  expect(await mail(restarted)).toHaveLength(2);
});
