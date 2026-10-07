import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { SeatQuestion, SeatRef } from "@clankie/agent-hosts";
import { OperatorConversationServiceResultSchema } from "@clankie/protocol";
import { ClaudeHookQuestions } from "../src/captain/claude-hook-questions.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import type { QuestionAuthority } from "../src/captain/conversation-questions.ts";
import { escalateWorkerQuestion } from "../src/captain/worker-question-escalation.ts";

const owner: QuestionAuthority = {
  principal: { kind: "operator", id: "owner" },
  current: () => true,
  authorize: async () => true,
};
const ask = (waitingOn: string, options = ["A", "B"]) => ({
  purpose: "decision" as const,
  kind: "choice" as const,
  prompt: "Which route?",
  waitingOn,
  recommendation: options[0]!,
  options: options.map((label) => ({ label })),
  allowFreeform: false,
});

it("keeps several worker and captain asks independent through reordered answers, cancellation, uncertainty and store restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "multiple-owner-asks-"));
  const registry = new ClaudeHookQuestions(join(root, "hook-claims.json"), 10000, 20);
  const refs: Record<string, SeatRef> = {
    alpha: { harness: "claude", paneId: "alpha-pane", sessionId: "alpha-native" },
    beta: { harness: "claude", paneId: "beta-pane", sessionId: "beta-native" },
  };
  const continuations: Array<{ requestId: string | undefined; ownerId: string | undefined }> = [];
  let store = new ConversationStore(join(root, "store"), async (_id, _message, _publish, context) => {
    continuations.push({
      requestId: context.inputAnswer?.requestId,
      ownerId: context.ownerAuthority?.principal.id,
    });
  });
  const wireNative = () => {
    store.prepareWorkerQuestion = async (seatId, requestId) => {
      const ref = refs[seatId]!;
      const question = registry.pending(ref, requestId);
      if (!question) throw new Error("Native question unavailable");
      return {
        seatId,
        requestId: question.requestId,
        sessionId: ref.sessionId,
        questions: question.questions.map(({ options, ...q }) => ({
          ...q,
          ...(options ? { options: [...options] } : {}),
        })),
      };
    };
    store.reconcileWorkerQuestion = async (question) => {
      const worker = question.workerQuestion!;
      return registry.pending(refs[worker.seatId]!, worker.requestId) ? "pending" : "resolved";
    };
    store.deliverWorkerAnswer = async (question, answer, authority) => {
      const worker = question.workerQuestion!;
      if (answer.kind !== "worker" || worker.sessionId !== refs[worker.seatId]!.sessionId)
        throw new Error("Wrong native target");
      const result = await registry.answer(
        refs[worker.seatId]!,
        { requestId: worker.requestId, answers: answer.answers },
        async () => {
          if (!authority.current() || !(await authority.authorize())) throw new Error("Owner authority lost");
        },
      );
      if (result.outcome !== "answered") throw new Error(result.detail);
    };
  };
  wireNative();
  try {
    const published: Record<string, SeatQuestion> = {};
    const notices: Promise<void>[] = [];
    const outputs = Object.fromEntries(
      Object.entries(refs).map(([seatId, ref]) => {
        let announce!: () => void;
        notices.push(
          new Promise<void>((resolve) => {
            announce = resolve;
          }),
        );
        return [
          seatId,
          registry.open(
            ref,
            {
              schemaVersion: 1,
              sessionId: ref.sessionId,
              event: "PreToolUse",
              toolName: "AskUserQuestion",
              toolUseId: "same-tool-id-different-session",
              toolInput: {
                questions: [
                  {
                    question: `${seatId}: framework?`,
                    header: "Framework",
                    options: [
                      { label: "React", description: "Components" },
                      { label: "Vue", description: "Progressive" },
                    ],
                  },
                  {
                    question: `${seatId}: style?`,
                    header: "Style",
                    options: [
                      { label: "Small", description: "Compact" },
                      { label: "Large", description: "Expanded" },
                    ],
                  },
                ],
              },
            },
            async (question) => {
              published[seatId] = question;
              await escalateWorkerQuestion(store, "global-default", seatId, question, {
                current: () => true,
                authorize: async () => true,
              });
              announce();
            },
          ),
        ];
      }),
    );
    await Promise.all(notices);
    const own = await store.requestSurfaceQuestion("global-default", ask("Choosing captain routing"), {
      current: () => true,
    });
    expect(
      (
        await store.requestSurfaceQuestion("global-default", ask("Choosing captain routing"), {
          current: () => true,
        })
      ).question?.requestId,
    ).toBe(own.question!.requestId);
    const separate = await store.requestSurfaceQuestion("global-default", ask("Choosing a different task"), {
      current: () => true,
    });
    const optionChange = await store.requestSurfaceQuestion(
      "global-default",
      ask("Choosing captain routing", ["C", "D"]),
      { current: () => true },
    );
    expect(new Set([own, separate, optionChange].map((r) => r.question!.requestId)).size).toBe(3);
    const listing = await store.serve(
      { op: "input_list", schemaVersion: 1, conversationId: "global-default" },
      owner,
    );
    if (listing.op !== "input_list") throw new Error("No list");
    OperatorConversationServiceResultSchema.parse(listing);
    expect(listing.result.questions).toHaveLength(5);
    expect(listing.result.questions.map((r) => r.question!.createdAt)).toEqual(
      listing.result.questions
        .map((r) => r.question!.createdAt)
        .sort()
        .reverse(),
    );
    expect(listing.result.questions.every((r) => !!r.question!.waitingOn)).toBe(true);
    const beta = listing.result.questions.find((r) => r.question!.workerQuestion?.seatId === "beta")!;
    const request = {
      op: "input_answer" as const,
      schemaVersion: 1 as const,
      conversationId: "global-default",
      requestId: beta.question!.requestId,
      incarnationId: beta.question!.incarnationId,
      expectedRevision: beta.revision!,
      answer: {
        kind: "worker" as const,
        answers: { q0: { answers: ["React"] }, q1: { answers: ["Small"] } },
      },
    };
    // A list started before dispatch must not reinterpret a claimed answer as
    // external resolution when its native reconciliation returns late.
    const reconcile = store.reconcileWorkerQuestion!;
    let entered!: () => void, release!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releasing = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.reconcileWorkerQuestion = async (question) => {
      if (question.requestId === request.requestId) {
        entered();
        await releasing;
        return "resolved";
      }
      return reconcile(question);
    };
    const listingDuringAnswer = store.serve({ op: "input_list", schemaVersion: 1 }, owner);
    await entering;
    store.reconcileWorkerQuestion = reconcile;
    const answering = store.serve(request, owner);
    expect((await outputs.beta!).hookSpecificOutput.updatedInput?.answers).toEqual({
      "beta: framework?": "React",
      "beta: style?": "Small",
    });
    release();
    await listingDuringAnswer;
    // The native pipe never acknowledges this answer: the real registry consumes it as uncertain.
    const uncertain = await answering;
    expect(uncertain).toMatchObject({
      result: { question: { requestId: request.requestId, reason: "worker_answer_uncertain" } },
    });
    if (uncertain.op !== "input_answer") throw new Error("Wrong answer response");
    await store.awaitRun(uncertain.result.question!.continuation!.runId);
    const readSeparate = await store.serve(
      {
        op: "input_get",
        schemaVersion: 1,
        conversationId: "global-default",
        requestId: separate.question!.requestId,
      },
      owner,
    );
    if (readSeparate.op !== "input_get") throw new Error("No ask");
    await store.serve(
      {
        op: "input_cancel",
        schemaVersion: 1,
        conversationId: "global-default",
        requestId: separate.question!.requestId,
        incarnationId: separate.question!.incarnationId,
        expectedRevision: readSeparate.result.revision!,
      },
      owner,
    );
    // Settled history may age out; the uncertain native claim must not.
    for (let index = 0; index < 36; index++) {
      const history = await store.requestSurfaceQuestion("global-default", ask(`Settled ${index}`), {
        current: () => true,
      });
      await store.serve(
        {
          op: "input_cancel",
          schemaVersion: 1,
          conversationId: "global-default",
          requestId: history.question!.requestId,
          incarnationId: history.question!.incarnationId,
          expectedRevision: history.revision!,
        },
        owner,
      );
    }
    await store.close();
    store = new ConversationStore(join(root, "store"), async (_id, _message, _publish, context) => {
      continuations.push({
        requestId: context.inputAnswer?.requestId,
        ownerId: context.ownerAuthority?.principal.id,
      });
    });
    wireNative();
    expect(
      await store.serve(
        {
          ...request,
          answer: { kind: "worker", answers: { q1: { answers: ["Small"] }, q0: { answers: ["React"] } } },
        },
        owner,
      ),
    ).toMatchObject({
      result: {
        status: "resolved",
        question: { requestId: request.requestId, reason: "worker_answer_uncertain" },
      },
    });
    expect(
      await registry.answer(refs.beta!, {
        requestId: published.beta!.requestId,
        answers: request.answer.answers,
      }),
    ).toMatchObject({ outcome: "refused" });
    const pending = await store.serve({ op: "input_list", schemaVersion: 1 }, owner);
    if (pending.op !== "input_list") throw new Error("No pending list");
    expect(pending.result.questions).toHaveLength(3);
    expect(pending.result.questions.some((r) => r.question!.requestId === own.question!.requestId)).toBe(
      true,
    );
    const alpha = pending.result.questions.find((r) => r.question!.workerQuestion?.seatId === "alpha")!;
    expect(
      await store.serve(
        { ...request, requestId: alpha.question!.requestId, incarnationId: alpha.question!.incarnationId },
        owner,
      ),
    ).toMatchObject({ result: { status: "revision_conflict" } });
    const accepted = store.serve(
      {
        ...request,
        requestId: alpha.question!.requestId,
        incarnationId: alpha.question!.incarnationId,
        expectedRevision: alpha.revision!,
      },
      owner,
    );
    const alphaOutput = await outputs.alpha!;
    expect(registry.acknowledge(refs.alpha!, alphaOutput.requestId!)).toBe(true);
    const resolved = await accepted;
    if (resolved.op !== "input_answer") throw new Error("No answer");
    await store.awaitRun(resolved.result.question!.continuation!.runId);
    expect(continuations.filter((c) => c.requestId === request.requestId)).toHaveLength(1);
    expect(continuations.filter((c) => c.requestId === alpha.question!.requestId)).toEqual([
      { requestId: alpha.question!.requestId, ownerId: "owner" },
    ]);
    expect(
      JSON.parse(await readFile(join(root, "store", "global-default", "meta.json"), "utf8")).questions
        .records,
    ).toHaveLength(36);
  } finally {
    Object.values(refs).forEach((ref) => registry.cancel(ref));
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("retains more than one recent-answer window of open asks and cancels only the chosen ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "pending-asks-retention-"));
  const store = new ConversationStore(root, async () => {});
  try {
    const asks = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        store.requestSurfaceQuestion("global-default", ask(`Task ${index}`), { current: () => true }),
      ),
    );
    expect(new Set(asks.map((r) => r.question!.requestId)).size).toBe(40);
    const list = await store.serve({ op: "input_list", schemaVersion: 1 }, owner);
    if (list.op !== "input_list") throw new Error("No list");
    expect(list.result.questions).toHaveLength(40);
    const target = asks[28]!.question!;
    expect(
      await store.serve(
        {
          op: "input_cancel",
          schemaVersion: 1,
          conversationId: "global-default",
          requestId: target.requestId,
          incarnationId: target.incarnationId,
          expectedRevision: list.result.questions[0]!.revision!,
        },
        owner,
      ),
    ).toMatchObject({
      result: { status: "resolved", question: { requestId: target.requestId, status: "cancelled" } },
    });
    const pending = await store.serve({ op: "input_list", schemaVersion: 1 }, owner);
    if (pending.op !== "input_list") throw new Error("No pending list");
    expect(pending.result.questions).toHaveLength(39);
    expect(pending.result.questions.some((r) => r.question!.requestId === asks[0]!.question!.requestId)).toBe(
      true,
    );
    for (let index = 40; index < 256; index++)
      await store.requestSurfaceQuestion("global-default", ask(`Task ${index}`), { current: () => true });
    await expect(
      store.requestSurfaceQuestion("global-default", ask("Over capacity"), { current: () => true }),
    ).rejects.toThrow();
    const full = await store.serve({ op: "input_list", schemaVersion: 1 }, owner);
    if (full.op !== "input_list") throw new Error("No full list");
    expect(full.result.questions).toHaveLength(255);
    expect(full.result.questions.some((r) => r.question!.requestId === asks[0]!.question!.requestId)).toBe(
      true,
    );
    store.cancelPendingQuestion("global-default", "source_reset");
    expect(await store.serve({ op: "input_list", schemaVersion: 1 }, owner)).toMatchObject({
      result: { questions: [] },
    });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("reconciles every native ask resolved elsewhere without cancelling an unrelated ask", async () => {
  const root = await mkdtemp(join(tmpdir(), "reconcile-all-asks-"));
  const registry = new ClaudeHookQuestions(join(root, "claims.json"), 10000);
  const store = new ConversationStore(join(root, "store"), async () => {});
  const refs: Record<string, SeatRef> = Object.fromEntries(
    ["first", "second"].map((seat) => [seat, { harness: "claude", paneId: seat, sessionId: seat }]),
  );
  const outputs: Promise<unknown>[] = [];
  store.prepareWorkerQuestion = async (seatId, requestId) => {
    const ref = refs[seatId]!;
    const question = registry.pending(ref, requestId)!;
    return {
      seatId,
      sessionId: ref.sessionId,
      requestId,
      questions: question.questions.map(({ options, ...q }) => ({
        ...q,
        ...(options ? { options: [...options] } : {}),
      })),
    };
  };
  store.reconcileWorkerQuestion = async (question) =>
    registry.pending(refs[question.workerQuestion!.seatId]!, question.workerQuestion!.requestId)
      ? "pending"
      : "resolved";
  try {
    for (const [seatId, ref] of Object.entries(refs)) {
      let notify!: () => void;
      const announced = new Promise<void>((resolve) => {
        notify = resolve;
      });
      outputs.push(
        registry.open(
          ref,
          {
            schemaVersion: 1,
            event: "PreToolUse",
            sessionId: ref.sessionId,
            toolName: "AskUserQuestion",
            toolUseId: seatId,
            toolInput: {
              questions: [
                {
                  question: "Choose",
                  header: "Route",
                  options: [
                    { label: "A", description: "A" },
                    { label: "B", description: "B" },
                  ],
                },
              ],
            },
          },
          async (question) => {
            await escalateWorkerQuestion(store, "global-default", seatId, question, {
              current: () => true,
              authorize: async () => true,
            });
            notify();
          },
        ),
      );
      await announced;
    }
    const own = await store.requestSurfaceQuestion("global-default", ask("Captain"), { current: () => true });
    registry.cancel(refs.second!);
    const remaining = await store.serve({ op: "input_list", schemaVersion: 1 }, owner);
    if (remaining.op !== "input_list") throw new Error("No list");
    expect(remaining.result.questions).toHaveLength(2);
    expect(remaining.result.questions.some((r) => r.question!.workerQuestion?.seatId === "first")).toBe(true);
    expect(remaining.result.questions.some((r) => r.question!.requestId === own.question!.requestId)).toBe(
      true,
    );
    registry.cancel(refs.first!);
    expect(await store.serve({ op: "input_list", schemaVersion: 1 }, owner)).toMatchObject({
      result: { questions: [{ question: { requestId: own.question!.requestId } }] },
    });
  } finally {
    Object.values(refs).forEach((ref) => registry.cancel(ref));
    await Promise.all(outputs);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("losing a legacy live owner leaves independent mailbox asks open", async () => {
  const root = await mkdtemp(join(tmpdir(), "legacy-and-mailbox-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let legacyId: string | undefined;
  const store = new ConversationStore(join(root, "store"), async (id, message, _publish, context) => {
    if (message === "Ask legacy")
      legacyId = (
        await store.requestQuestion(
          id,
          { kind: "text", prompt: "Preferred style?", options: [], allowFreeform: true },
          context,
        )
      ).question!.requestId;
  });
  try {
    const created = await store.serve({
      op: "create",
      schemaVersion: 1,
      scope: { kind: "workspace", workspaceId: workspace },
      title: "Mixed asks",
    });
    if (created.op !== "create") throw new Error("No conversation");
    const id = created.conversation.conversationId;
    const own = await store.requestSurfaceQuestion(id, ask("Independent task"), { current: () => true });
    const sent = await store.serve(
      {
        op: "send",
        schemaVersion: 1,
        turn: {
          schemaVersion: 1,
          kind: "message",
          conversationId: id,
          expectedRevision: own.revision!,
          message: "Ask legacy",
          surfaceClientId: "fixture",
        },
      },
      owner,
    );
    if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("No run");
    await store.awaitRun(sent.result.runId);
    const list = await store.serve({ op: "input_list", schemaVersion: 1, conversationId: id }, owner);
    if (list.op !== "input_list") throw new Error("No list");
    expect(list.result.questions).toHaveLength(2);
    await store.serve({
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId: id,
        expectedRevision: list.result.questions[0]!.revision!,
        message: "No live owner",
        surfaceClientId: "fixture",
      },
    });
    expect(
      await store.serve(
        { op: "input_get", schemaVersion: 1, conversationId: id, requestId: legacyId },
        owner,
      ),
    ).toMatchObject({ result: { question: { status: "cancelled", reason: "owner_context_lost" } } });
    expect(
      await store.serve({ op: "input_list", schemaVersion: 1, conversationId: id }, owner),
    ).toMatchObject({
      result: { questions: [{ question: { requestId: own.question!.requestId, status: "pending" } }] },
    });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
