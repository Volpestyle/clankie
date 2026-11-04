import { z } from "zod";

/**
 * Structured asks from workers (#604). A worker that needs a decision raises
 * one inside its ordinary `message_clankie` report, as one JSON block, so the
 * report, its receipt and every harness bridge stay exactly as they are. Its
 * lead (Clankie, a Duet thread, any connected lead) and the app list it as a
 * card, and the answer goes back to the worker tied to the ask's id. Worker
 * questions go to their lead; nothing here routes one to the owner.
 */

/** Terminal escape sequences: CSI, OSC (BEL or ST terminated) and two-byte escapes. */
// eslint-disable-next-line no-control-regex -- removing these is the point.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_]?/gu;
/** Line-breaking controls become a space. */
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
/**
 * Everything that renders as nothing or reorders what is around it is removed:
 * every format character (bidi embeddings, overrides and isolates, the Arabic
 * letter mark, zero-width joiners and spaces, word joiner, BOM, soft hyphen),
 * every default-ignorable code point (variation selectors, Hangul fillers, tag
 * characters), private-use and lone surrogates, and blank glyphs that
 * Unicode does not class as ignorable.
 */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Co}\p{Cs}\u2800\u115f\u1160\u3164\uffa0]/gu;
/** What a reader can see: a letter, digit, punctuation or symbol. */
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;

/** A worker's words as one plain line, before any emptiness or length check. */
function plainWorkerText(value: string): string {
  return value.replace(ANSI, "").replace(BREAKS, " ").replace(INVISIBLE, "").replace(/\s+/gu, " ").trim();
}

/**
 * A worker's words as one plain line that a card or terminal shows exactly:
 * nothing in it can restyle, reorder or forge what is around it, and a line
 * that would show blank is refused.
 */
const plainLine = (max: number) =>
  z
    .string()
    .max(max * 4)
    .transform(plainWorkerText)
    .pipe(
      z
        .string()
        .min(1)
        .max(max)
        .refine((value) => VISIBLE.test(value), { message: "Must contain visible text" }),
    );

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
      reason: z.enum([
        "unknown_ask",
        "settled",
        "invalid_answer",
        "not_your_worker",
        /** The worker that raised the ask left its seat, or its lead changed; nothing was sent. */
        "recipient_changed",
        /** The answering lead's authority ended before the send; nothing was sent. */
        "unauthorized",
        "undelivered",
      ]),
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
 * The ask list as a device may read it through the relay: bare, or filtered by
 * exactly one known state. No other query, encoding or duplicate is accepted.
 */
export const isWorkerAskListRoute = (path: string) =>
  /^\/v1\/fleet\/asks(?:\?state=(?:open|answering|answered|withdrawn))?$/u.test(path);

/** One ask's answer or withdraw route, by its lowercase UUID; anything else is not one. */
export const workerAskActionRoute = (path: string): "answer" | "withdraw" | undefined =>
  /^\/v1\/fleet\/asks\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(answer|withdraw)$/u.exec(
    path,
  )?.[1] as "answer" | "withdraw" | undefined;

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
