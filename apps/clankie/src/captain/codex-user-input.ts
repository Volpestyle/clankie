import { z } from "zod";
import type { SeatQuestion } from "@clankie/agent-hosts";

const NativeRequestIdSchema = z.union([z.string().min(1).max(200), z.number().int().safe()]);
const AnswerValuesSchema = z
  .record(
    z.string().min(1).max(200),
    z
      .object({
        answers: z.array(z.string().max(32_768)).min(1).max(16),
      })
      .strict(),
  )
  .refine((answers) => Object.keys(answers).length > 0 && Object.keys(answers).length <= 3);
export const SeatQuestionAnswerSchema = z
  .object({
    requestId: NativeRequestIdSchema,
    answers: AnswerValuesSchema,
  })
  .strict();
const QuestionSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1),
  isBlocking: z.boolean().default(true),
  questions: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
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
    .max(3),
});

export function codexQuestion(requestId: unknown, params: unknown): SeatQuestion | undefined {
  const id = NativeRequestIdSchema.safeParse(requestId);
  const parsed = QuestionSchema.safeParse(params);
  if (
    !id.success ||
    !parsed.success ||
    new Set(parsed.data.questions.map((q) => q.id)).size !== parsed.data.questions.length
  )
    return undefined;
  const { threadId: _thread, ...question } = parsed.data;
  return { requestId: id.data, ...question };
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
