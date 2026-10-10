import { z } from "zod";
import { SpawnOperatorSeatSchema } from "./operator-conversations.ts";

/**
 * Routines: owner-defined recurring jobs (ADR 0265). One schedule, one target,
 * a missed-run policy and a run log. A routine runs with the authority of the
 * conversation it targets, never more.
 */
export const ROUTINES_PATH = "/v1/captain/routines";

export const ROUTINE_NAME_MAX = 80;
export const ROUTINE_PROMPT_MAX = 8_000;
export const ROUTINE_HISTORY_MAX = 200;

const RoutineIdSchema = z.string().regex(/^rt_[a-z0-9]{8,32}$/u, "Use a routine id such as rt_ab12cd34");
export const RoutineNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(ROUTINE_NAME_MAX)
  .regex(/^[^\p{Cc}]+$/u, "Routine names cannot contain control characters");

/** Five-field cron (minute hour day-of-month month day-of-week), checked fully by the service. */
export const RoutineCronSchema = z
  .string()
  .trim()
  .regex(/^\S+(\s+\S+){4}$/u, "Use five cron fields: minute hour day month weekday");

export const RoutineTimeZoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Use an IANA time zone");

export const RoutineScheduleSchema = z
  .object({
    cron: RoutineCronSchema,
    timeZone: RoutineTimeZoneSchema,
    /** The owner's own words when the schedule came from plain language. */
    text: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type RoutineSchedule = z.infer<typeof RoutineScheduleSchema>;

/** What a routine does when its Mac slept through one or more runs. */
export const RoutineMissedPolicySchema = z.enum(["catch_up", "skip"]);
export type RoutineMissedPolicy = z.infer<typeof RoutineMissedPolicySchema>;

const ConversationIdSchema = z.string().trim().min(1).max(256);

/** A hire's fields, as `hire_agent` takes them; resumes and fresh intents are one-off, never recurring. */
export const RoutineHireSchema = SpawnOperatorSeatSchema.omit({
  schemaVersion: true,
  resume: true,
  freshIntent: true,
});
export type RoutineHire = z.infer<typeof RoutineHireSchema>;

/** A turn in a lead conversation with this prompt. */
const RoutineTurnTargetSchema = z
  .object({
    kind: z.literal("turn"),
    conversationId: ConversationIdSchema,
    prompt: z.string().trim().min(1).max(ROUTINE_PROMPT_MAX),
  })
  .strict();
/** A hire led by this conversation, briefed with this prompt. */
const RoutineHireTargetSchema = z
  .object({
    kind: z.literal("hire"),
    conversationId: ConversationIdSchema,
    hire: RoutineHireSchema,
    brief: z.string().trim().min(1).max(ROUTINE_PROMPT_MAX),
  })
  .strict();
/** A command run through `clankie heavy`; its result is reported to the conversation. */
const RoutineCheckTargetSchema = z
  .object({
    kind: z.literal("check"),
    conversationId: ConversationIdSchema,
    command: z
      .array(
        z
          .string()
          .min(1)
          .max(4096)
          .refine((arg) => !arg.includes("\u0000"), "Arguments cannot contain NUL"),
      )
      .min(1)
      .max(64),
    workingDirectory: z.string().trim().min(1).max(4096),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(6 * 60 * 60)
      .optional(),
    /** When the conversation hears the result; the run log always records it. */
    report: z.enum(["always", "failure"]).optional(),
  })
  .strict();

export const RoutineTargetSchema = z.discriminatedUnion("kind", [
  RoutineTurnTargetSchema,
  RoutineHireTargetSchema,
  RoutineCheckTargetSchema,
]);
export type RoutineTarget = z.infer<typeof RoutineTargetSchema>;

/** A target as a command names it; without a conversation it goes to Clankie's main chat. */
const optionalConversation = { conversationId: ConversationIdSchema.optional() };
export const RoutineTargetInputSchema = z.discriminatedUnion("kind", [
  RoutineTurnTargetSchema.extend(optionalConversation),
  RoutineHireTargetSchema.extend(optionalConversation),
  RoutineCheckTargetSchema.extend(optionalConversation),
]);
export type RoutineTargetInput = z.infer<typeof RoutineTargetInputSchema>;

export const RoutineRunStatusSchema = z.enum(["running", "succeeded", "failed", "interrupted", "skipped"]);
export type RoutineRunStatus = z.infer<typeof RoutineRunStatusSchema>;
export const RoutineRunTriggerSchema = z.enum(["schedule", "catch_up", "manual"]);

export const RoutineRunSchema = z
  .object({
    id: z.string().uuid(),
    routineId: RoutineIdSchema,
    trigger: RoutineRunTriggerSchema,
    /** The schedule slot this run claimed; a manual run claims its own start time. */
    slot: z.string().datetime(),
    status: RoutineRunStatusSchema,
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    /** What happened, in a sentence: the turn ran, the seat hired, the check's exit. */
    detail: z.string().max(4000).optional(),
    /** Slots this run stood in for, or skipped, while the Mac slept. */
    missed: z.number().int().nonnegative().optional(),
    links: z.array(z.string().min(1).max(2000)).max(20).optional(),
  })
  .strict();
export type RoutineRun = z.infer<typeof RoutineRunSchema>;

export const RoutineSchema = z
  .object({
    id: RoutineIdSchema,
    name: RoutineNameSchema,
    schedule: RoutineScheduleSchema,
    target: RoutineTargetSchema,
    enabled: z.boolean(),
    missed: RoutineMissedPolicySchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    /** "owner" through the API, or the lead conversation that made it. */
    createdBy: z.string().min(1).max(256),
    nextRunAt: z.string().datetime().optional(),
    lastRun: RoutineRunSchema.optional(),
  })
  .strict();
export type Routine = z.infer<typeof RoutineSchema>;

/** Plain-language or cron schedule input; the service resolves it to a cron in a time zone. */
export const RoutineScheduleInputSchema = z
  .object({
    /** "every weekday at 9:00", "every friday at 17:30", "every 2 hours", or five cron fields. */
    when: z.string().trim().min(1).max(200),
    timeZone: RoutineTimeZoneSchema.optional(),
  })
  .strict();

const RoutineRefSchema = z.object({ id: RoutineIdSchema }).strict();
export const RoutineCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z
    .object({
      action: z.literal("add"),
      name: RoutineNameSchema,
      schedule: RoutineScheduleInputSchema,
      target: RoutineTargetInputSchema,
      missed: RoutineMissedPolicySchema.optional(),
      enabled: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("edit"),
      id: RoutineIdSchema,
      name: RoutineNameSchema.optional(),
      schedule: RoutineScheduleInputSchema.optional(),
      target: RoutineTargetInputSchema.optional(),
      missed: RoutineMissedPolicySchema.optional(),
    })
    .strict(),
  RoutineRefSchema.extend({ action: z.literal("pause") }).strict(),
  RoutineRefSchema.extend({ action: z.literal("resume") }).strict(),
  RoutineRefSchema.extend({ action: z.literal("run_now") }).strict(),
  RoutineRefSchema.extend({ action: z.literal("remove") }).strict(),
  z
    .object({
      action: z.literal("history"),
      id: RoutineIdSchema.optional(),
      limit: z.number().int().min(1).max(ROUTINE_HISTORY_MAX).optional(),
    })
    .strict(),
]);
export type RoutineCommand = z.infer<typeof RoutineCommandSchema>;

export const RoutinesStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** The routines file could not be read; nothing runs and nothing is overwritten until it is fixed. */
    error: z.literal("state_unreadable").optional(),
    routines: z.array(RoutineSchema),
    /** Newest first; present for history, and for the routine a command touched. */
    runs: z.array(RoutineRunSchema).optional(),
    /** The routine a command created or changed. */
    routine: RoutineSchema.optional(),
  })
  .strict();
export type RoutinesStatus = z.infer<typeof RoutinesStatusSchema>;
