import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { SeatQuestion } from "@clankie/agent-hosts";
import { OperatorConversationServiceResultSchema } from "@clankie/protocol";
import { ConversationStore } from "../src/captain/conversations.ts";
import { ClaudeHookQuestions } from "../src/captain/claude-hook-questions.ts";
import { escalateWorkerQuestion } from "../src/captain/worker-question-escalation.ts";

it("escalates a real pending Claude permission through the owner ask store and resolves once by native ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-owner-escalation-"));
  const registry = new ClaudeHookQuestions(join(root, "native-claims.json"));
  const ref = { harness: "claude" as const, paneId: "worker-pane", sessionId: "native-session" };
  const store = new ConversationStore(join(root, "conversations"), async () => {});
  const owner = {
    principal: { kind: "operator" as const, id: "owner" },
    current: () => true,
    authorize: async () => true,
  };
  let native!: SeatQuestion;
  let publish!: () => void;
  const announced = new Promise<void>((resolve) => {
    publish = resolve;
  });
  store.prepareWorkerQuestion = async (seatId, requestId) => {
    const q = registry.pending(ref, requestId);
    if (!q) throw new Error("Native question unavailable");
    return {
      seatId,
      requestId: q.requestId,
      sessionId: ref.sessionId,
      questions: q.questions.map(({ options, ...q }) => ({
        ...q,
        ...(options ? { options: [...options] } : {}),
      })),
    };
  };
  store.deliverWorkerAnswer = async (q, answer, authority) => {
    if (answer.kind !== "worker" || q.workerQuestion?.sessionId !== ref.sessionId)
      throw new Error("Wrong native answer");
    const result = await registry.answer(
      ref,
      { requestId: q.workerQuestion.requestId, answers: answer.answers },
      async () => {
        if (!authority.current() || !(await authority.authorize())) throw new Error("Owner unavailable");
      },
      { kind: "owner", principal: authority.principal },
    );
    if (result.outcome !== "answered") throw new Error("Native answer unconfirmed");
  };
  store.reconcileWorkerQuestion = async (q) =>
    registry.pending(ref, q.workerQuestion!.requestId) ? "pending" : "resolved";
  try {
    const hookResult = registry.open(
      ref,
      {
        schemaVersion: 1,
        sessionId: ref.sessionId,
        event: "PermissionRequest",
        toolName: "Bash",
        toolUseId: "permission-invocation",
        toolInput: { command: "git push" },
      },
      async (question) => {
        native = question;
        await escalateWorkerQuestion(store, "global-default", "worker-seat", question, {
          current: () => true,
          authorize: async () => true,
        });
        publish();
      },
    );
    await announced;
    expect(native.gate).toBe("moneyAndAccounts");
    const read = await store.serve(
      { op: "input_get", schemaVersion: 1, conversationId: "global-default" },
      owner,
    );
    if (read.op !== "input_get" || !read.result.question) throw new Error("No owner ask");
    const q = read.result.question;
    expect(q.workerQuestion?.requestId).toBe(native.requestId);
    expect(q.workerQuestion?.questions[0]?.options?.map((o) => o.label)).toEqual(["Allow", "Deny"]);
    const request = {
      op: "input_answer" as const,
      schemaVersion: 1 as const,
      conversationId: q.conversationId,
      requestId: q.requestId,
      incarnationId: q.incarnationId,
      expectedRevision: read.result.revision!,
      answer: { kind: "worker" as const, answers: { q0: { answers: ["Allow"] } } },
    };
    const answering = store.serve(request, owner);
    const output = await hookResult;
    expect(output.hookSpecificOutput).toMatchObject({ decision: { behavior: "allow" } });
    expect(registry.acknowledge(ref, output.requestId!)).toBe(true);
    const answered = OperatorConversationServiceResultSchema.parse(await answering);
    expect(answered).toMatchObject({
      op: "input_answer",
      result: { status: "resolved", question: { status: "submitted" } },
    });
    expect(
      await registry.answer(ref, { requestId: native.requestId, answers: { q0: { answers: ["Deny"] } } }),
    ).toMatchObject({ outcome: "refused" });
    expect(await store.serve(request, owner)).toEqual(answered);
  } finally {
    registry.cancel(ref);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
