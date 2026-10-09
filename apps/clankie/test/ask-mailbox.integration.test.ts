import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { OperatorConversationServiceResultSchema } from "@clankie/protocol";
import { ConversationStore, type ConversationTurnContext } from "../src/captain/conversations.ts";
import { QuestionDraftSchema, type QuestionAuthority } from "../src/captain/conversation-questions.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const owner: QuestionAuthority = {
  principal: { kind: "operator", id: "owner" },
  current: () => true,
  authorize: async () => true,
};
const draft = () =>
  QuestionDraftSchema.parse({
    purpose: "decision",
    kind: "choice",
    prompt: "Which route?",
    options: [{ label: "A" }, { label: "B" }],
    recommendation: "A",
    waitingOn: "Routing the work",
  });
it.each(["global", "room", "native"])(
  "persists a %s ask across restart and resolves once through protocol receipts",
  async (surface) => {
    const root = mkdtempSync(join(tmpdir(), "ask-mailbox-"));
    roots.push(root);
    const calls: Array<{ id: string; context: ConversationTurnContext }> = [];
    const runner = async (
      id: string,
      _message: string,
      _publish: unknown,
      context: ConversationTurnContext,
    ) => {
      calls.push({ id, context });
    };
    let store = new ConversationStore(root, runner);
    const id = surface === "room" ? store.roomConversation("discord_presence", "123:456") : "global-default";
    if (surface === "native") store.questionEligible = () => false;
    const asked = await store.requestSurfaceQuestion(id, draft(), { current: () => true });
    const pending = await store.requestSurfaceQuestion(id, draft(), { current: () => true });
    expect(pending.question?.requestId).toBe(asked.question!.requestId);
    await store.close();
    store = new ConversationStore(root, runner);
    const listed = OperatorConversationServiceResultSchema.parse(
      await store.serve({ op: "input_list", schemaVersion: 1 }, owner),
    );
    expect(listed).toMatchObject({
      op: "input_list",
      result: { questions: [{ question: { requestId: asked.question!.requestId, status: "pending" } }] },
    });
    const get = await store.serve({ op: "input_get", schemaVersion: 1, conversationId: id }, owner);
    if (get.op !== "input_get" || !get.result.question) throw new Error("missing pending ask");
    const q = get.result.question;
    const request = {
      op: "input_answer" as const,
      schemaVersion: 1 as const,
      conversationId: id,
      requestId: q.requestId,
      incarnationId: q.incarnationId,
      expectedRevision: get.result.revision!,
      answer: { kind: "choice" as const, optionId: q.options[0]!.optionId },
    };
    const [answered, duplicate] = await Promise.all([
      store.serve(request, owner),
      store.serve(request, owner),
    ]);
    OperatorConversationServiceResultSchema.parse(answered);
    expect(duplicate).toEqual(answered);
    if (answered.op !== "input_answer") throw new Error("wrong response");
    await store.awaitRun(answered.result.question!.continuation!.runId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe(id);
    expect(calls[0]!.context.inputAnswer?.requestId).toBe(q.requestId);
    expect(calls[0]!.context.ownerAuthority).toBe(owner);
    expect(readFileSync(join(root, id, "events.jsonl"), "utf8")).toContain('"role":"operator"');
    await store.close();
  },
);
it("deduplicates native escalation across source conversations and consumes uncertain answer delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "ask-worker-"));
  roots.push(root);
  const messages: string[] = [];
  const store = new ConversationStore(root, async (_id, message) => {
    messages.push(message);
  });
  store.prepareWorkerQuestion = async (seatId, requestId) => ({
    seatId,
    requestId,
    sessionId: "native-session",
    questions: [
      { id: "route", question: "Which route?", options: [{ label: "A" }, { label: "B" }] },
      { id: "style", question: "Which style?", options: [{ label: "Small" }, { label: "Large" }] },
    ],
  });
  let delivered = 0;
  store.deliverWorkerAnswer = async () => {
    delivered++;
    throw new Error("worker_answer_offline");
  };
  const d = QuestionDraftSchema.parse({ ...draft(), workerQuestion: { seatId: "seat", requestId: 42 } });
  const first = await store.requestSurfaceQuestion("global-default", d, { current: () => true });
  const room = store.roomConversation("discord_presence", "1:2");
  const repeated = await store.requestSurfaceQuestion(room, d, { current: () => true });
  expect(repeated.question?.requestId).toBe(first.question!.requestId);
  expect(repeated.conversationId).toBe("global-default");
  const q = first.question!;
  const request = {
    op: "input_answer" as const,
    schemaVersion: 1 as const,
    conversationId: q.conversationId,
    requestId: q.requestId,
    incarnationId: q.incarnationId,
    expectedRevision: first.revision!,
    answer: {
      kind: "worker" as const,
      answers: { route: { answers: ["A"] }, style: { answers: ["Small"] } },
    },
  };
  const answer = await store.serve(request, owner);
  if (answer.op !== "input_answer") throw new Error("wrong response");
  await store.awaitRun(answer.result.question!.continuation!.runId);
  expect(
    await store.serve(
      {
        ...request,
        answer: { kind: "worker", answers: { style: { answers: ["Small"] }, route: { answers: ["A"] } } },
      },
      owner,
    ),
  ).toMatchObject({ result: { status: "resolved" } });
  expect(delivered).toBe(1);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("worker_answer_offline");
  // Ordinary retained answers must never evict an uncertain native send claim.
  for (let index = 0; index < 34; index++) {
    const recent = await store.requestSurfaceQuestion("global-default", draft(), { current: () => true });
    await store.serve(
      {
        op: "input_cancel",
        schemaVersion: 1,
        conversationId: recent.conversationId,
        requestId: recent.question!.requestId,
        incarnationId: recent.question!.incarnationId,
        expectedRevision: recent.revision!,
      },
      owner,
    );
  }
  const retained = await store.requestSurfaceQuestion(room, d, { current: () => true });
  expect(retained.question?.requestId).toBe(q.requestId);
  expect(retained.question?.status).toBe("submitted");
  expect(delivered).toBe(1);
  await store.close();
});

it("reconciles proof of native resolution once and wakes the source without inventing an owner answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "ask-external-"));
  roots.push(root);
  const messages: string[] = [];
  const store = new ConversationStore(root, async (_id, message) => {
    messages.push(message);
  });
  store.prepareWorkerQuestion = async (seatId, requestId) => ({
    seatId,
    requestId,
    sessionId: "native",
    questions: [{ id: "q", question: "Choose?" }],
  });
  const asked = await store.requestSurfaceQuestion(
    "global-default",
    QuestionDraftSchema.parse({ ...draft(), workerQuestion: { seatId: "seat", requestId: "request" } }),
    { current: () => true },
  );
  store.reconcileWorkerQuestion = async () => "resolved";
  await store.serve({ op: "input_list", schemaVersion: 1 }, owner);
  await store.serve({ op: "input_list", schemaVersion: 1 }, owner);
  await store.close();
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("not an owner answer");
  expect(
    await store.serve(
      {
        op: "input_get",
        schemaVersion: 1,
        conversationId: "global-default",
        requestId: asked.question!.requestId,
      },
      owner,
    ),
  ).toMatchObject({ result: { question: { status: "cancelled", reason: "worker_question_resolved" } } });
});

it("preserves an owner action across native attachment, restart, and attributed cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "ask-takeover-"));
  roots.push(root);
  let store = new ConversationStore(root, async () => {});
  const asked = await store.requestSurfaceQuestion(
    "global-default",
    QuestionDraftSchema.parse({
      purpose: "owner_action",
      kind: "text",
      prompt: "Run the read-only diagnosis?",
      waitingOn: "Root-cause evidence",
      steps: ["Run the owner-approved diagnostics"],
    }),
    { current: () => true },
  );
  const source = {
    paneId: "w1:p1",
    terminalId: "owner-seat",
    agent: "codex" as const,
    status: "idle",
    title: "Owner",
    session: { source: "herdr:codex", kind: "id" as const, value: "native-thread" },
  };
  store.rememberNativeSource("global-default", source);
  store.rememberNativeSource("global-default", source);
  await store.close();
  store = new ConversationStore(root, async () => {});
  const get = await store.serve(
    {
      op: "input_get",
      schemaVersion: 1,
      conversationId: "global-default",
      requestId: asked.question!.requestId,
    },
    owner,
  );
  if (get.op !== "input_get") throw new Error("wrong response");
  expect(get.result.question).toEqual(asked.question);
  const cancel = await store.serve(
    {
      op: "input_cancel",
      schemaVersion: 1,
      conversationId: "global-default",
      requestId: asked.question!.requestId,
      incarnationId: asked.question!.incarnationId,
      expectedRevision: get.result.revision!,
    },
    owner,
  );
  OperatorConversationServiceResultSchema.parse(cancel);
  expect(cancel).toMatchObject({
    result: {
      question: {
        status: "cancelled",
        reason: "owner_cancelled",
        resolvedBy: owner.principal,
      },
    },
  });
  const events = readFileSync(join(root, "global-default", "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.filter((event) => event.type === "input_resolved")).toEqual([
    expect.objectContaining({ outcome: "cancelled", requestId: asked.question!.requestId }),
  ]);
  await store.close();
  store = new ConversationStore(root, async () => {});
  expect(await store.serve({ op: "input_list", schemaVersion: 1, status: "cancelled" }, owner)).toMatchObject(
    { result: { questions: [{ question: { resolvedBy: owner.principal, reason: "owner_cancelled" } }] } },
  );
  await store.close();
});
it("attributes automatic cancellation to the service without inventing an owner answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "ask-service-cancel-"));
  roots.push(root);
  const store = new ConversationStore(root, async () => {});
  const asked = await store.requestSurfaceQuestion("global-default", draft(), { current: () => true });
  store.cancelPendingQuestion("global-default", "conversation_closed");
  const got = await store.serve(
    {
      op: "input_get",
      schemaVersion: 1,
      conversationId: "global-default",
      requestId: asked.question!.requestId,
    },
    owner,
  );
  OperatorConversationServiceResultSchema.parse(got);
  expect(got).toMatchObject({
    result: {
      question: {
        status: "cancelled",
        reason: "conversation_closed",
        resolvedBy: { kind: "service", id: "clankie" },
      },
    },
  });
  if (got.op !== "input_get") throw new Error("wrong response");
  expect(got.result.question?.answer).toBeUndefined();
  await store.close();
});

it("keeps historical takeover cancellations cancelled with unknown attribution", async () => {
  const root = mkdtempSync(join(tmpdir(), "ask-legacy-cancel-"));
  roots.push(root);
  let store = new ConversationStore(root, async () => {});
  const asked = await store.requestSurfaceQuestion("global-default", draft(), { current: () => true });
  await store.close();
  const path = join(root, "global-default", "meta.json");
  const meta = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(meta.questions.records[0].question, {
    status: "cancelled",
    reason: "native_seat_takeover",
    resolvedAt: new Date().toISOString(),
  });
  writeFileSync(path, JSON.stringify(meta));
  store = new ConversationStore(root, async () => {});
  const got = await store.serve(
    {
      op: "input_get",
      schemaVersion: 1,
      conversationId: "global-default",
      requestId: asked.question!.requestId,
    },
    owner,
  );
  OperatorConversationServiceResultSchema.parse(got);
  if (got.op !== "input_get") throw new Error("wrong response");
  expect(got.result.question?.status).toBe("cancelled");
  expect(got.result.question?.reason).toBe("native_seat_takeover");
  expect(got.result.question?.resolvedBy).toBeUndefined();
  expect(got.result.question?.answer).toBeUndefined();
  await store.close();
});

it("answers the same owner-action request after native takeover without cancelling or duplicating it", async () => {
  const root = mkdtempSync(join(tmpdir(), "ask-takeover-answer-"));
  roots.push(root);
  let continuations = 0;
  const store = new ConversationStore(root, async () => {
    continuations++;
  });
  const asked = await store.requestSurfaceQuestion(
    "global-default",
    QuestionDraftSchema.parse({
      purpose: "owner_action",
      kind: "text",
      prompt: "Run diagnostics?",
      waitingOn: "Root evidence",
      steps: ["Run the read-only command"],
    }),
    { current: () => true },
  );
  store.rememberNativeSource("global-default", {
    paneId: "w1:p1",
    terminalId: "owner-seat",
    agent: "codex",
    status: "idle",
    title: "Owner",
    session: { source: "herdr:codex", kind: "id", value: "native-thread" },
  });
  const get = await store.serve(
    {
      op: "input_get",
      schemaVersion: 1,
      conversationId: "global-default",
      requestId: asked.question!.requestId,
    },
    owner,
  );
  if (get.op !== "input_get") throw new Error("wrong response");
  expect(get.result.question?.status).toBe("pending");
  const target = {
    op: "input_answer" as const,
    schemaVersion: 1 as const,
    conversationId: "global-default",
    requestId: asked.question!.requestId,
    incarnationId: asked.question!.incarnationId,
    expectedRevision: get.result.revision!,
    answer: { kind: "text" as const, text: "I'll run it" },
  };
  const answer = await store.serve(target, owner);
  OperatorConversationServiceResultSchema.parse(answer);
  if (answer.op !== "input_answer") throw new Error("wrong response");
  expect(answer.result.question).toMatchObject({
    status: "submitted",
    resolvedBy: owner.principal,
    answer: target.answer,
  });
  await store.awaitRun(answer.result.question!.continuation!.runId);
  await store.serve(target, owner);
  expect(continuations).toBe(1);
  await store.close();
});
