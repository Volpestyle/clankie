import { z } from "zod";

/**
 * Structured asks from workers (#604). A worker that needs a decision raises
 * one inside its ordinary `message_clankie` report, as one JSON block, so the
 * report, its receipt and every harness bridge stay exactly as they are. Its
 * lead (Clankie, a Duet thread, any connected lead) and the app list it as a
 * card, and the answer goes back to the worker tied to the ask's id. Worker
 * questions go to their lead; nothing here routes one to the owner.
 */

/**
 * A worker's words as one plain line: ANSI escapes and control characters
 * removed and whitespace collapsed, so a card or a terminal shows exactly the
 * text and nothing the worker wrote can restyle or rewrite what is around it.
 */
const plainLine = (max: number) =>
  z
    .string()
    .max(max * 4)
    .transform((value) =>
      value
        // eslint-disable-next-line no-control-regex -- removing these is the point.
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/gu, "")
        // eslint-disable-next-line no-control-regex -- C0, DEL and C1 controls.
        .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim(),
    )
    .pipe(z.string().min(1).max(max));

export const WORKER_ASK_OPTIONS_MIN = 2;
export const WORKER_ASK_OPTIONS_MAX = 5;

/** The risky action an ask confirms, when it is a confirmation rather than a choice. */
export const WorkerAskConfirmsSchema = z.enum(["push", "merge", "restart", "rotate", "delete", "release"]);
export type WorkerAskConfirms = z.infer<typeof WorkerAskConfirmsSchema>;

export const WorkerAskOptionSchema = z
  .object({
    /** What the worker receives back, verbatim: a short token, safe on any command line. */
    value: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
    /** What the lead and the app show. */
    label: plainLine(120),
  })
  .strict();
export type WorkerAskOption = z.infer<typeof WorkerAskOptionSchema>;

/** What a worker writes, inside `{"ask": …}` in its report text. */
export const WorkerAskDraftSchema = z
  .object({
    question: plainLine(500),
    options: z
      .array(WorkerAskOptionSchema)
      .min(WORKER_ASK_OPTIONS_MIN)
      .max(WORKER_ASK_OPTIONS_MAX)
      .refine((options) => new Set(options.map((option) => option.value)).size === options.length, {
        message: "Option values must be distinct",
      }),
    /** The lead may answer in its own words instead of choosing an option. */
    freeText: z.boolean().optional(),
    confirms: WorkerAskConfirmsSchema.optional(),
  })
  .strict();
export type WorkerAskDraft = z.infer<typeof WorkerAskDraftSchema>;

/** The report-text envelope: `{"ask": {...}}`. */
export const WorkerAskEnvelopeSchema = z.object({ ask: WorkerAskDraftSchema }).strict();

export const WorkerAskIdSchema = z.string().uuid();

export const WorkerAskAnswerSchema = z.union([
  z.object({ value: z.string().trim().min(1).max(64) }).strict(),
  z.object({ text: plainLine(2_000) }).strict(),
]);
export type WorkerAskAnswer = z.infer<typeof WorkerAskAnswerSchema>;

export const WorkerAskSchema = z
  .object({
    /** The report's delivery id: one report raises at most one ask. */
    askId: WorkerAskIdSchema,
    seatId: z.string().min(1).max(256),
    paneId: z.string().min(1).max(256),
    /** The lead conversation the report reached. */
    conversationId: z.string().min(1).max(256),
    raisedAt: z.iso.datetime({ offset: true }),
    ask: WorkerAskDraftSchema,
    /**
     * `answering` holds an answer whose delivery was uncertain: it is never
     * resent, and a later answer is refused until the worker is heard from.
     */
    state: z.enum(["open", "answering", "answered", "withdrawn"]),
    answer: WorkerAskAnswerSchema.optional(),
    settledAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export type WorkerAsk = z.infer<typeof WorkerAskSchema>;

export const WorkerAskListSchema = z
  .object({ schemaVersion: z.literal(1), asks: z.array(WorkerAskSchema).max(200) })
  .strict();
export type WorkerAskList = z.infer<typeof WorkerAskListSchema>;

export const WorkerAskResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("answered"), ask: WorkerAskSchema }).strict(),
  z.object({ outcome: z.literal("withdrawn"), ask: WorkerAskSchema }).strict(),
  /** The answer may have reached the worker; it is never resent. */
  z.object({ outcome: z.literal("uncertain"), ask: WorkerAskSchema, detail: z.string() }).strict(),
  z
    .object({
      outcome: z.literal("refused"),
      reason: z.enum(["unknown_ask", "settled", "invalid_answer", "not_your_worker", "undelivered"]),
      detail: z.string(),
    })
    .strict(),
]);
export type WorkerAskResult = z.infer<typeof WorkerAskResultSchema>;

export const WORKER_ASKS_PATH = "/v1/fleet/asks";
export const WORKER_ASK_ANSWER_PATH = "/v1/fleet/asks/:askId/answer";
export const WORKER_ASK_WITHDRAW_PATH = "/v1/fleet/asks/:askId/withdraw";
export const workerAskAnswerPath = (askId: string) => `/v1/fleet/asks/${encodeURIComponent(askId)}/answer`;
export const workerAskWithdrawPath = (askId: string) =>
  `/v1/fleet/asks/${encodeURIComponent(askId)}/withdraw`;

/**
 * The ask inside a report's text, if it carries one: a fenced JSON block or
 * the whole text, `{"ask": {...}}`. Anything else is an ordinary report.
 */
export function workerAskIn(text: string): WorkerAskDraft | undefined {
  // Reports are bounded already; an ask block is far smaller than this.
  if (text.length > 64 * 1024) return undefined;
  const fenced = [...text.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/gu)].map((match) => match[1]!);
  for (const candidate of [...fenced, text.trim()]) {
    if (!candidate.startsWith("{") || !candidate.includes('"ask"')) continue;
    try {
      const parsed = WorkerAskEnvelopeSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data.ask;
    } catch {
      /* Not JSON: an ordinary report. */
    }
  }
  return undefined;
}
