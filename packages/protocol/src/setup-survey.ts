import { z } from "zod";
import { AutonomyLevelSchema } from "./autonomy.ts";
import { MachineAccessLevelSchema } from "./machine-access.ts";

/**
 * Setup's one read-only agent (ADR 0320). After the owner picks his Herdr
 * session, Clankie may hire one agent on an account the owner already uses. It
 * starts in its harness's read-only mode, looks around, and reports one
 * proposal. The owner approves it line by line, and only approved lines run.
 */
export const SETUP_SURVEY_PATH = "/v1/setup/survey";
export const SETUP_SURVEY_APPLY_PATH = "/v1/setup/survey/apply";
export const SETUP_SURVEY_CANCEL_PATH = "/v1/setup/survey/cancel";

const lineId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/u);
const connectionId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
/** Owner-facing text: one plain sentence or two, no control characters. */
const words = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}]+$/u, "Use plain text without control characters");
const why = words(400);

/**
 * One thing the agent proposes. Clankie applies `add_machine`,
 * `connect_session`, `machine_access` and `autonomy` himself through the same
 * APIs setup and Settings use. `pair_phone`, `connect_lead` and `owner_step`
 * are the owner's own steps: approving one shows him how, and nothing runs.
 */
export const SetupSurveyLineSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("add_machine"),
      id: lineId,
      why,
      /** The name Clankie keeps it under. */
      machine: connectionId,
      ssh: z.string().regex(/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/u),
      shell: z.enum(["posix", "powershell"]).default("posix"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("connect_session"),
      id: lineId,
      why,
      /** A machine Clankie already has, or one an `add_machine` line in this proposal adds. */
      machine: connectionId,
      session: z.string().regex(/^[\w][\w.-]{0,63}$/u),
    })
    .strict(),
  z
    .object({
      kind: z.literal("machine_access"),
      id: lineId,
      why,
      machine: connectionId,
      accessLevel: MachineAccessLevelSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("autonomy"),
      id: lineId,
      why,
      level: z.union([z.literal("watch"), AutonomyLevelSchema]),
    })
    .strict(),
  z.object({ kind: z.literal("pair_phone"), id: lineId, why }).strict(),
  z
    .object({
      kind: z.literal("connect_lead"),
      id: lineId,
      why,
      /** The lead as the owner knows it, such as "Claude Code" or "Grok". */
      lead: words(64),
    })
    .strict(),
  /** Something only the owner can do outside Clankie, such as installing Herdr on another computer. */
  z.object({ kind: z.literal("owner_step"), id: lineId, why, step: words(400) }).strict(),
]);
export type SetupSurveyLine = z.infer<typeof SetupSurveyLineSchema>;

export const SetupSurveyProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** What the agent found, in a sentence or two. */
    summary: words(600),
    findings: z.array(words(400)).max(24).default([]),
    lines: z
      .array(SetupSurveyLineSchema)
      .max(24)
      .refine(
        (lines) => new Set(lines.map((line) => line.id)).size === lines.length,
        "Line ids must be unique",
      ),
  })
  .strict();
export type SetupSurveyProposal = z.infer<typeof SetupSurveyProposalSchema>;

export const SetupSurveyLineResultSchema = z
  .object({
    lineId,
    /** `yours`: an owner step; approving it showed him how and ran nothing. */
    outcome: z.enum(["applied", "failed", "yours"]),
    detail: z.string().max(600).optional(),
  })
  .strict();
export type SetupSurveyLineResult = z.infer<typeof SetupSurveyLineResultSchema>;

export const SetupSurveyStatusSchema = z.enum(["surveying", "proposed", "applied", "cancelled", "failed"]);

export const SetupSurveySchema = z
  .object({
    id: z.string().uuid(),
    status: SetupSurveyStatusSchema,
    startedAt: z.string(),
    endedAt: z.string().optional(),
    harness: z.literal("claude"),
    account: z.string().max(64).optional(),
    seatId: z.string().max(256).optional(),
    /** Watch was on when the survey started; Clankie turns it back on when the survey ends. */
    restoresWatch: z.boolean(),
    proposal: SetupSurveyProposalSchema.optional(),
    results: z.array(SetupSurveyLineResultSchema).max(24).optional(),
    /** Why the survey failed, in the owner's words. */
    detail: z.string().max(600).optional(),
  })
  .strict();
export type SetupSurvey = z.infer<typeof SetupSurveySchema>;

/** Not strict, so later fields reach older readers as ignored keys. */
export const SetupSurveySnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  survey: SetupSurveySchema.optional(),
});
export type SetupSurveySnapshot = z.infer<typeof SetupSurveySnapshotSchema>;

export const StartSetupSurveySchema = z
  .object({
    schemaVersion: z.literal(1),
    /** A signed-in Claude account label from `GET /v1/worker-accounts`; absent, Clankie picks one. */
    account: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/u)
      .optional(),
  })
  .strict();
export const ApplySetupSurveySchema = z
  .object({
    schemaVersion: z.literal(1),
    surveyId: z.string().uuid(),
    /** The approved lines; every other line is declined. Empty declines them all. */
    lineIds: z.array(lineId).max(24),
  })
  .strict();
export const CancelSetupSurveySchema = z
  .object({ schemaVersion: z.literal(1), surveyId: z.string().uuid() })
  .strict();
export type StartSetupSurvey = z.infer<typeof StartSetupSurveySchema>;
export type ApplySetupSurvey = z.infer<typeof ApplySetupSurveySchema>;
export type CancelSetupSurvey = z.infer<typeof CancelSetupSurveySchema>;
