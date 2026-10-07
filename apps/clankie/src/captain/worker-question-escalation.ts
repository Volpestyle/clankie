import type { SeatQuestion } from "@clankie/agent-hosts";
import type { ConversationStore } from "./conversations.ts";

/** Keep owner inbox questions in the existing ask store and retain native IDs. */
export async function escalateWorkerQuestion(
  store: ConversationStore,
  conversationId: string,
  seatId: string,
  question: SeatQuestion,
  admission: { current: () => boolean; authorize: () => Promise<boolean> },
): Promise<void> {
  const result = await store.requestSurfaceQuestion(
    conversationId,
    {
      purpose: "decision",
      kind: "text",
      prompt: question.questions[0]?.question.slice(0, 2000) ?? "A worker question needs your answer.",
      waitingOn: `Worker ${seatId} is waiting on its native question.`,
      recommendation: "Review the original question and answer through its harness channel.",
      options: [],
      allowFreeform: false,
      gate: question.gate ?? "everydayWork",
      workerQuestion: { seatId, requestId: question.requestId },
    },
    admission,
  );
  if (result.status !== "ready" || result.question?.workerQuestion?.requestId !== question.requestId)
    throw new Error("Owner ask unavailable or another question is already pending");
}
