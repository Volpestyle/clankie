import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
