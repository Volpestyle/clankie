import type {
  ConversationQuestionAnswer,
  ConversationQuestionResult,
  OperatorConversationServiceClient,
} from "@clankie/protocol";
import type { SetupFlow } from "./shell/setup-flow.ts";

const nonempty = (value: string) =>
  value.trim().length > 0 && value.trim().length <= 4000
    ? undefined
    : "Enter an answer of 1–4000 characters.";

/** Uses the same centered choices and text fields as the rest of the console. */
export async function questionMailbox(
  client: OperatorConversationServiceClient,
  flow: SetupFlow,
  displayed: (snapshot: ConversationQuestionResult | undefined) => void,
): Promise<string> {
  if (!client.inputList || !client.inputGet || !client.inputAnswer)
    throw new Error("Owner asks are unavailable");
  flow.begin("Owner asks");
  try {
    const [mail, conversations] = await Promise.all([client.inputList({ status: "pending" }), client.list()]);
    const titles = new Map(conversations.map((c) => [c.conversationId, c.title]));
    const pending = mail.questions
      .filter((s) => s.question?.status === "pending")
      .sort((a, b) => b.question!.createdAt.localeCompare(a.question!.createdAt));
    if (!pending.length) return "No pending asks";
    const selected = await flow.readSelect({
      scrollMessage: true,
      message: "Owner asks\nAll conversations · newest first",
      options: pending.map((s) => {
        const q = s.question!;
        const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(q.createdAt)) / 60000));
        return {
          value: q.requestId,
          label: `${titles.get(q.conversationId) ?? "Clankie"} · ${q.issue?.key ?? { preference: "Preference", decision: "Decision", approval: "Approval", owner_action: "Your action", verify: "Check it works", gate: "Approval" }[q.purpose]}`,
          description: `${minutes < 1 ? "just now" : `${minutes}m ago`} · ${q.waitingOn ? `Waiting on ${q.waitingOn} · ` : ""}${q.prompt}`,
        };
      }),
    });
    if (!selected) return "Mailbox closed";
    // The detail view is the displayed snapshot. Never re-read just before sending.
    const listed = pending.find((s) => s.question!.requestId === selected)!;
    const snapshot = await client.inputGet(listed.conversationId, selected);
    const q = snapshot.question;
    if (!q || q.status !== "pending" || snapshot.revision === undefined)
      return "This ask has already settled. Open /question to refresh the mailbox.";
    displayed(snapshot);
    const source = titles.get(q.conversationId) ?? "Clankie";
    const message = [
      q.prompt,
      `From: ${source}`,
      q.issue ? `${q.issue.key} · ${q.issue.url}` : "",
      q.waitingOn ? `Waiting on: ${q.waitingOn}` : "",
      q.recommendation ? `Recommended: ${q.recommendation}` : "",
      ...(q.steps ?? []).map((step, i) => `${i + 1}. ${step}`),
    ]
      .filter(Boolean)
      .join("\n");
    let answer: ConversationQuestionAnswer | undefined;
    if (q.workerQuestion) {
      const answers: Record<string, { answers: string[] }> = {};
      for (const item of q.workerQuestion.questions) {
        const options = item.options ?? [];
        const pick = options.length
          ? await flow.readSelect({
              message: `${message}\n${item.question}`,
              options: [
                ...options.map((o, i) => ({
                  value: String(i),
                  label: o.label,
                  description: o.description ?? "",
                })),
                { value: "text", label: "Write an answer" },
              ],
              allowBack: false,
              scrollMessage: true,
            })
          : "text";
        if (pick === undefined) return "Mailbox closed";
        const value =
          pick === "text"
            ? await (item.isSecret ? flow.readSecret : flow.readText)({
                message: `${message}\n${item.question}`,
                validate: nonempty,
                allowBack: false,
                scrollMessage: true,
              })
            : options[Number(pick)]!.label;
        if (value === undefined) return "Mailbox closed";
        answers[item.id] = { answers: [value.trim()] };
      }
      answer = { kind: "worker", answers };
    } else if (q.kind === "text") {
      const text = await flow.readText({
        message,
        validate: nonempty,
        allowBack: false,
        scrollMessage: true,
      });
      if (text !== undefined) answer = { kind: "text", text: text.trim() };
    } else {
      const sendBack =
        q.purpose === "verify" ? q.options.find((o) => /^send (?:it )?back$/iu.test(o.label)) : undefined;
      const pick = await flow.readSelect({
        message,
        allowBack: false,
        scrollMessage: true,
        options: [
          ...q.options.map((o) => ({ value: o.optionId, label: o.label, description: o.description ?? "" })),
          ...(q.allowFreeform && !sendBack
            ? [
                {
                  value: "text",
                  label: q.purpose === "verify" ? "Send back" : "Write an answer",
                  description: q.purpose === "verify" ? "Give a reason for another fix" : "",
                },
              ]
            : []),
        ],
      });
      if (pick === "text" || (sendBack !== undefined && pick === sendBack.optionId)) {
        const text = await flow.readText({
          message: `${message}\n${q.purpose === "verify" ? "Reason to send back" : "Your answer"}`,
          validate: nonempty,
          allowBack: false,
          scrollMessage: true,
        });
        if (text !== undefined) answer = { kind: "text", text: text.trim() };
      } else if (pick !== undefined) answer = { kind: "choice", optionId: pick };
    }
    if (!answer) return "Mailbox closed";
    flow.setStatus("Sending answer…");
    displayed(undefined);
    const result = await client.inputAnswer({
      conversationId: q.conversationId,
      requestId: q.requestId,
      incarnationId: q.incarnationId,
      expectedRevision: snapshot.revision,
      answer,
    });
    if (result.status === "revision_conflict") {
      await client.inputGet(q.conversationId, q.requestId).catch(() => undefined);
      throw new Error(
        "The conversation changed. Your answer was not applied. Open /question and choose the ask again.",
      );
    }
    if (result.status === "refused") throw new Error(result.reason ?? "Answer refused");
    if (result.question?.requestId !== q.requestId || result.question.status !== "submitted") {
      await client.inputGet(q.conversationId, q.requestId);
      throw new Error(
        "This ask has changed or settled. Open /question to refresh; no new answer was applied.",
      );
    }
    displayed(result);
    return `Answer sent to ${source}${q.issue ? ` · ${q.issue.key}` : ""}. ${result.question?.status === "submitted" ? "The ask has settled." : ""}`.trim();
  } finally {
    flow.end();
  }
}
