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
      prompt:
        (question.permission
          ? question.questions[0]?.question.split("\n", 1)[0]
          : question.questions[0]?.question
        )?.slice(0, 2000) ?? "A worker question needs your answer.",
      waitingOn: question.permission
        ? "Your answer lets this step run or keeps it stopped."
        : `Worker ${seatId} is waiting on its native question.`,
      recommendation: question.permission
        ? "Review the details before deciding."
        : "Review the original question and answer through its harness channel.",
      options: [],
      allowFreeform: false,
      gate: question.gate ?? "everydayWork",
      workerQuestion: { seatId, requestId: question.requestId },
    },
    admission,
  );
  if (result.status !== "ready" || result.question?.workerQuestion?.requestId !== question.requestId)
    throw new Error("Owner ask unavailable or native question identity changed");
}
