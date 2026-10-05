import { z } from "zod";
import type { SeatQuestion, SeatQuestionAnswer } from "@clankie/agent-hosts";

const NativeRequestIdSchema = z.union([z.string().min(1).max(200), z.number().int().safe()]);
const AnswerValuesSchema = z
  .record(
    z.string().min(1).max(512),
    z
      .object({
        answers: z.array(z.string().max(32_768)).min(1).max(16),
      })
      .strict(),
  )
  .refine((answers) => Object.keys(answers).length > 0 && Object.keys(answers).length <= 16);
export const SeatQuestionAnswerSchema = z
  .object({
    requestId: NativeRequestIdSchema,
    answers: AnswerValuesSchema,
  })
  .strict();
const QuestionSchema = z
  .object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    itemId: z.string().min(1),
    isBlocking: z.boolean().default(true),
    delivery: z.literal("async").optional(),
    questions: z
      .array(
        z.object({
          id: z.string().min(1).max(512),
          header: z.string(),
          question: z.string(),
          isOther: z.boolean().default(false),
          isSecret: z.boolean().default(false),
          options: z
            .array(z.object({ label: z.string(), description: z.string() }))
            .nullable()
            .default(null),
        }),
      )
      .min(1)
      .max(16),
  })
  .refine((question) => question.delivery === "async" || question.questions.length <= 3);

export function codexQuestion(requestId: unknown, params: unknown): SeatQuestion | undefined {
  const id = NativeRequestIdSchema.safeParse(requestId);
  const parsed = QuestionSchema.safeParse(params);
  if (
    !id.success ||
    !parsed.success ||
    new Set(parsed.data.questions.map((q) => q.id)).size !== parsed.data.questions.length
  )
    return undefined;
  const { threadId: _thread, delivery, ...question } = parsed.data;
  return { requestId: id.data, ...question, ...(delivery === undefined ? {} : { delivery }) };
}

const AsyncQuestionItemSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  item: z.object({
    type: z.literal("agentMessage"),
    id: z.string().min(1).max(200),
    delivery: z.literal("async"),
    questions: z
      .array(
        z.object({
          title: z.string().min(1).max(32_768),
          options: z.array(z.string().min(1)).nullable().optional(),
        }),
      )
      .min(1)
      .max(16),
  }),
});

/** Codex 0.160 async questions are delivered messages, not server requests. */
export function codexAsyncQuestion(params: unknown): SeatQuestion | undefined {
  const parsed = AsyncQuestionItemSchema.safeParse(params);
  if (!parsed.success) return undefined;
  const { item, turnId } = parsed.data;
  return {
    requestId: item.id,
    itemId: item.id,
    turnId,
    isBlocking: false,
    delivery: "async",
    questions: item.questions.map((question, index) => ({
      // This is the identity shared by the native desktop and TUI question editors.
      id: JSON.stringify(["request_user_input_async", item.id, index]),
      header: `Question ${index + 1}`,
      question: question.title,
      isOther: true,
      isSecret: false,
      options:
        question.options
          ?.slice(0, 32)
          .filter((label) => Buffer.byteLength(label) <= 512)
          .map((label) => ({ label, description: "" })) ?? null,
    })),
  };
}

const replyStart = "<send_user_message_question_reply>";
const replyEnd = "</send_user_message_question_reply>";
const AsyncRepliesSchema = z
  .array(
    z.object({
      answer: z.string(),
      question: z.string(),
      questionItemId: z.string().min(1).max(512),
    }),
  )
  .min(1)
  .max(16);

/** Match the native AnsweredQuestion envelope, including its bounded UTF-8 framing. */
export function codexAsyncQuestionAnswer(question: SeatQuestion, answer: SeatQuestionAnswer): string {
  const replies = question.questions.map((entry) => {
    const bytes = Buffer.from(entry.question);
    let end = Math.min(bytes.length, 512);
    while (end < bytes.length && end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    return {
      answer: answer.answers[entry.id]!.answers.join("\n"),
      question: bytes
        .subarray(0, end)
        .toString("utf8")
        .replace(/[\n\r]/gu, " "),
      questionItemId: entry.id,
    };
  });
  return `${replyStart}\n${JSON.stringify(replies)}\n${replyEnd}`;
}

/** Only native user-message items can retire an async question from another client. */
export function codexAnsweredAsyncQuestionIds(item: unknown): readonly string[] {
  const parsed = z
    .object({
      type: z.literal("userMessage"),
      content: z.array(z.unknown()),
    })
    .safeParse(item);
  if (!parsed.success) return [];
  const ids: string[] = [];
  for (const input of parsed.data.content) {
    const text = z.object({ type: z.literal("text"), text: z.string() }).safeParse(input);
    if (!text.success) continue;
    const value = text.data.text.trim();
    if (!value.startsWith(replyStart) || !value.endsWith(replyEnd)) continue;
    try {
      const replies = AsyncRepliesSchema.safeParse(
        JSON.parse(value.slice(replyStart.length, -replyEnd.length)),
      );
      if (replies.success) ids.push(...replies.data.map((reply) => reply.questionItemId));
    } catch {
      /* Ordinary user text is not an attributed async answer. */
    }
  }
  return ids;
}

export interface CodexAsyncAnswerReceipt {
  readonly turnId: string;
  readonly clientUserMessageId: string;
  readonly text: string;
}

/** An async tool's accepted:true output proves no answer; the exact user input does. */
export function recordedCodexAsyncAnswer(
  value: unknown,
  threadId: string,
  receipt: CodexAsyncAnswerReceipt,
): "unobserved" | "accepted" | "answered_concurrently_by_owner" {
  const parsed = z
    .object({
      thread: z.object({
        id: z.literal(threadId),
        turns: z.array(z.object({ id: z.string(), items: z.array(z.unknown()) })),
      }),
    })
    .safeParse(value);
  if (!parsed.success) return "unobserved";
  const turn = parsed.data.thread.turns.find((turn) => turn.id === receipt.turnId);
  const accepted = (turn?.items ?? []).some((item) => {
    const user = z
      .object({
        type: z.literal("userMessage"),
        clientId: z.literal(receipt.clientUserMessageId),
        content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
      })
      .safeParse(item);
    return user.success && user.data.content.length === 1 && user.data.content[0]!.text === receipt.text;
  });
  const answeredIds = codexAnsweredAsyncQuestionIds({
    type: "userMessage",
    content: [{ type: "text", text: receipt.text }],
  });
  for (const turn of parsed.data.thread.turns)
    for (const item of turn.items) {
      const user = z
        .object({ type: z.literal("userMessage"), clientId: z.string().nullable().optional() })
        .safeParse(item);
      if (!user.success || user.data.clientId === receipt.clientUserMessageId) continue;
      if (codexAnsweredAsyncQuestionIds(item).some((id) => answeredIds.includes(id)))
        return "answered_concurrently_by_owner";
    }
  return accepted ? "accepted" : "unobserved";
}

/** Codex's persisted request_user_input tool output, scoped to its exact turn/call. */
export function recordedCodexAnswer(value: unknown, question: SeatQuestion, threadId: string): unknown {
  const result = z
    .object({
      thread: z.object({
        id: z.literal(threadId),
        turns: z.array(
          z.object({
            id: z.string(),
            items: z.array(z.unknown()),
          }),
        ),
      }),
    })
    .safeParse(value);
  if (!result.success) return undefined;
  const turn = result.data.thread.turns.find((turn) => turn.id === question.turnId);
  for (const value of turn?.items ?? []) {
    const item = z
      .object({
        type: z.literal("functionCallOutput"),
        id: z.literal(question.itemId),
        name: z.literal("request_user_input"),
        output: z.string(),
      })
      .safeParse(value);
    if (!item.success) continue;
    try {
      const answer = z.object({ answers: AnswerValuesSchema }).safeParse(JSON.parse(item.data.output));
      if (answer.success) return answer.data.answers;
    } catch {
      /* A malformed output supplies no acceptance proof. */
    }
  }
  return undefined;
}
