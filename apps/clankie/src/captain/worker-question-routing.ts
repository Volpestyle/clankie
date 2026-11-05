import { WorkerAnswerRefused } from "./conversation-questions.ts";
import { escalateWorkerQuestion } from "./worker-question-escalation.ts";
import { requireOwnerQuestionMachineAccess } from "../machine-access.ts";
import { createWatchGate } from "../watch.ts";
import type { SettingsStore } from "@clankie/settings";
import type { ConversationStore } from "./conversations.ts";
import type { HerdrWatchStore } from "./herdr-watch.ts";

/** Host-only wiring for native question routing and owner answers; no model input grants this path. */
export function connectWorkerQuestions({
  conversations,
  herdrWatches,
  settingsStore,
  shutdown,
}: {
  conversations: ConversationStore;
  herdrWatches: HerdrWatchStore;
  settingsStore: SettingsStore;
  shutdown: AbortController;
}): void {
  const watch = createWatchGate(settingsStore);
  herdrWatches.watching = () => watch.watching();
  herdrWatches.questionRoutingFence = async () => {
    const policy = await settingsStore.loadFenced();
    return { watching: policy.settings.autonomy.watch === true, assertCurrent: policy.assertCurrent };
  };
  conversations.watching = () => watch.watching();
  conversations.reconcileWatchQuestions = () => herdrWatches.reconcileWatchQuestions();
  herdrWatches.returnQuestionToLead = (seatId, sessionId, requestId) =>
    conversations.returnWatchQuestionToLead(seatId, sessionId, requestId);
  herdrWatches.escalateQuestion = async (owner, agent, question, guard) => {
    await escalateWorkerQuestion(conversations, owner.conversationId, agent.terminalId, question, {
      workerQuestionWatch: await watch.watching(),
      current: () => {
        (guard as import("./conversation-owner.ts").AuthorityGuard).assertCurrent?.();
        return !shutdown.signal.aborted;
      },
      authorize: async () => {
        await guard();
        return true;
      },
    });
    await guard();
  };
  conversations.prepareWorkerQuestion = async (seatId, requestId) => {
    const observed = await herdrWatches.observedSeatQuestion(seatId, requestId);
    if (observed.question.questions.some((question) => question.isSecret))
      throw new Error("worker_secret_question_requires_native_owner_input");
    return {
      seatId,
      requestId: observed.question.requestId,
      sessionId: observed.sessionId,
      questions: observed.question.questions.map((question) => ({
        ...question,
        ...(question.options === null ? { options: undefined } : { options: [...question.options] }),
      })),
    };
  };
  conversations.reconcileWorkerQuestion = async (question) => {
    const worker = question.workerQuestion;
    const status = worker
      ? await herdrWatches.workerQuestionStatus(worker.seatId, worker.requestId, worker.sessionId)
      : "unknown";
    return status === "unknown" ? "uncertain" : status;
  };
  conversations.deliverWorkerAnswer = async (question, answer, authority, assertOpen) => {
    const worker = question.workerQuestion;
    if (!worker || answer.kind !== "worker") throw new Error("worker_answer_invalid");
    const delivery = await herdrWatches.answerSeatQuestion(
      worker.seatId,
      { requestId: worker.requestId, answers: answer.answers },
      {
        owner: { conversationId: question.conversationId },
        current: () =>
          authority.current() &&
          !shutdown.signal.aborted &&
          conversations.conversation(question.conversationId) !== undefined,
        authorize: async () =>
          authority.current() &&
          (await authority.authorize()) &&
          !shutdown.signal.aborted &&
          conversations.conversation(question.conversationId) !== undefined,
      },
      worker.sessionId,
      authority.principal,
      {
        assertCurrent: assertOpen,
        access: (fleet) =>
          requireOwnerQuestionMachineAccess(settingsStore, fleet, { assertCurrent: assertOpen }),
      },
    );
    if (delivery.outcome === "undelivered")
      throw new WorkerAnswerRefused(delivery.detail ?? "worker_answer_refused");
    if (delivery.outcome !== "delivered")
      throw new Error(
        `worker_answer_${delivery.outcome}: ${delivery.detail ?? "No confirmed native answer"}`,
      );
  };
}
