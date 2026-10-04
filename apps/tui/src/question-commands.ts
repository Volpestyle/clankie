import type { ConversationQuestionResult, OperatorConversationServiceClient } from "@clankie/protocol";

/** An answer targets the last displayed immutable request, never a newly fetched replacement. */
export function questionConsoleCommand(
  client: OperatorConversationServiceClient,
  conversation: () => string | undefined,
) {
  let shown: ConversationQuestionResult | undefined;
  return async (argument: string): Promise<string> => {
    const conversationId = conversation();
    if (!conversationId || !client.inputGet || !client.inputAnswer || !client.inputCancel)
      throw new Error("Select an owner workspace conversation first");
    const command = argument.trim();
    if (!command) {
      let snapshot = await client.inputGet(conversationId);
      if (!snapshot.question && shown?.conversationId === conversationId && shown.question)
        snapshot = await client.inputGet(conversationId, shown.question.requestId);
      shown = snapshot;
      return formatQuestion(shown);
    }
    const q = shown?.question;
    if (
      !q ||
      q.status !== "pending" ||
      shown?.conversationId !== conversationId ||
      shown.revision === undefined
    )
      throw new Error("Read the current question with /question before answering");
    const target = {
      conversationId,
      requestId: q.requestId,
      incarnationId: q.incarnationId,
      expectedRevision: shown.revision,
    };
    let result: ConversationQuestionResult;
    if (command === "cancel") result = await client.inputCancel(target);
    else if (command.startsWith("answer ")) {
      const index = Number(command.slice(7));
      const option = Number.isInteger(index) && index > 0 ? q.options[index - 1] : undefined;
      if (!option) throw new Error("Choose one of the displayed option numbers");
      result = await client.inputAnswer({ ...target, answer: { kind: "choice", optionId: option.optionId } });
    } else if (command.startsWith("text ") && command.slice(5).trim()) {
      result = await client.inputAnswer({
        ...target,
        answer: { kind: "text", text: command.slice(5).trim() },
      });
    } else throw new Error("Usage: /question [answer NUMBER | text TEXT | cancel]");
    shown = result;
    if (result.status === "revision_conflict") {
      shown = undefined;
      throw new Error("The conversation changed. Read /question again before choosing.");
    }
    if (result.status === "refused") throw new Error(result.reason ?? "Question response refused");
    return formatQuestion(result);
  };
}

function formatQuestion(result: ConversationQuestionResult): string {
  const q = result.question;
  if (!q) return result.reason ?? "No pending preference question";
  if (q.status !== "pending")
    return `Question ${q.requestId}: ${q.status}${q.reason ? ` (${q.reason})` : ""}${q.continuation ? `; continuation ${q.continuation.runId}: ${q.continuation.state}` : ""}`;
  return [
    q.prompt,
    ...q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`),
    `Request ${q.requestId}`,
    "Use /question answer NUMBER, /question text TEXT, or /question cancel.",
    result.reason ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}
