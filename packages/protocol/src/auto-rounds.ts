import { z } from "zod";
import { ProjectOwnerLoopSchema } from "./project-work-policy.ts";

/** The Auto round record (ADR 0270): `clankie auto rounds` and its operator route. */
export const AUTO_ROUNDS_PATH = "/v1/auto/rounds";

const Unknown = z.object({ state: z.literal("unknown"), reason: z.string() }).strict();
const ChurnLinesSchema = z
  .object({
    product: z.number().int().nonnegative(),
    tooling: z.number().int().nonnegative(),
    docs: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
  })
  .strict();
export const VelocityMilestoneSchema = z
  .object({
    kind: z.enum(["parent", "milestone"]),
    ref: z.string(),
    at: z.string(),
    id: z.string().optional(),
  })
  .strict();
const VelocityDaySchema = z
  .object({
    date: z.string(),
    inWindow: z.boolean(),
    working: z.boolean().nullable(),
    lines: ChurnLinesSchema.nullable(),
    closed: z
      .object({
        ownerFacing: z.number().int().nonnegative(),
        tooling: z.number().int().nonnegative(),
        unlinked: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    stateChanges: z.number().int().nonnegative().nullable(),
  })
  .strict();

/** A drift signal a round detected (ADR 0270). `day` is the local day it refers to. */
export const DriftDetectionSchema = z
  .object({
    signal: z.enum(["tooling_lead", "nothing_closed", "over_wip"]),
    day: z.string(),
    numbers: z.record(z.string(), z.number()),
    /** Detected by an earlier round whose wake was not delivered; carried until one is. */
    carried: z.boolean().optional(),
  })
  .strict();
export type DriftDetection = z.infer<typeof DriftDetectionSchema>;

/** A lead's chosen response, attached to the round that named the detection. */
export const DriftCorrectionSchema = z
  .object({
    roundId: z.string(),
    issue: z.string(),
    reason: z.string(),
    recordedAt: z.string(),
  })
  .strict();
export type DriftCorrection = z.infer<typeof DriftCorrectionSchema>;

export const DriftCorrectionCheckSchema = z
  .object({
    correction: DriftCorrectionSchema,
    checkedAt: z.string(),
    /** Null means the relevant source was unavailable, never a failed correction. */
    issueStarted: z.boolean().nullable(),
    productLines: z.number().int().nonnegative().nullable(),
    state: z.enum(["satisfied", "unresolved", "unknown"]),
    reasons: z.array(z.string()),
  })
  .strict();
export type DriftCorrectionCheck = z.infer<typeof DriftCorrectionCheckSchema>;

const ProjectStatusUpdateSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    url: z.string().nullable(),
    health: z.string().nullable(),
  })
  .strict();
export const VelocityLandingSchema = z.object({ sha: z.string(), at: z.string() }).strict();
export const MilestoneReportSchema = z
  .object({
    /** Exactly one update is requested for these newly seen milestones together. */
    milestones: z.array(VelocityMilestoneSchema),
    cadence: ProjectOwnerLoopSchema.optional(),
    landings: z.array(VelocityLandingSchema).optional(),
    updates: z.array(ProjectStatusUpdateSchema.extend({ unexpected: z.boolean() })),
  })
  .strict();
export type MilestoneReport = z.infer<typeof MilestoneReportSchema>;

/** One project's outcomes for one Auto round. Unreadable parts are `unknown`, never zero. */
export const ProjectVelocitySchema = z
  .object({
    projectId: z.string(),
    ownerLoop: ProjectOwnerLoopSchema.optional(),
    landings: z
      .union([
        z.object({ state: z.literal("known"), commits: z.array(VelocityLandingSchema) }).strict(),
        Unknown,
      ])
      .optional(),
    tracker: z
      .object({ kind: z.enum(["linear", "built-in"]), projectId: z.string() })
      .strict()
      .optional(),
    name: z.string(),
    measuredAt: z.string(),
    timeZone: z.string(),
    window: z
      .object({ since: z.string(), until: z.string(), from: z.enum(["milestone", "lookback"]) })
      .strict(),
    lastMilestone: VelocityMilestoneSchema.nullable(),
    milestones: z.array(VelocityMilestoneSchema),
    /** Tracker updates observed at measurement time; unknown never means an empty feed. */
    statusUpdates: z
      .union([
        z.object({ state: z.literal("known"), updates: z.array(ProjectStatusUpdateSchema) }).strict(),
        Unknown,
      ])
      .optional(),
    /** Absent on historical rounds before VUH-2286. Updates are reconciled on later ticks. */
    report: MilestoneReportSchema.optional(),
    closures: z.union([
      z
        .object({
          state: z.literal("known"),
          ownerFacing: z.array(z.string()),
          tooling: z.array(z.string()),
          unlinked: z.array(z.string()),
          unclassified: z.array(z.string()),
        })
        .strict(),
      Unknown,
    ]),
    started: z.union([
      z
        .object({
          state: z.literal("known"),
          total: z.number().int().nonnegative(),
          byState: z.record(z.string(), z.number().int().nonnegative()),
          cap: z.number().int().min(1).max(1000).nullable(),
        })
        .strict(),
      Unknown,
    ]),
    churn: z.union([
      z
        .object({
          state: z.literal("known"),
          lines: ChurnLinesSchema,
          commits: z.number().int().nonnegative(),
        })
        .strict(),
      Unknown,
    ]),
    days: z.array(VelocityDaySchema),
    caveats: z.array(z.string()),
    /** Absent on rounds recorded before drift detection (VUH-2284). */
    drift: z.array(DriftDetectionSchema).optional(),
    correction: DriftCorrectionSchema.optional(),
    correctionCheck: DriftCorrectionCheckSchema.optional(),
  })
  .strict();
export type ProjectVelocity = z.infer<typeof ProjectVelocitySchema>;
export type VelocityMilestone = z.infer<typeof VelocityMilestoneSchema>;

export const AutoRoundSchema = z
  .object({
    roundId: z.string(),
    conversationId: z.string(),
    at: z.string(),
    /** Null while the wake has not settled, or when the service stopped before it did. */
    delivery: z
      .object({ delivered: z.boolean(), at: z.string(), reason: z.string().optional() })
      .strict()
      .nullable(),
    projects: z.array(ProjectVelocitySchema),
  })
  .strict();
export const AutoRoundsResponseSchema = z
  .object({ schemaVersion: z.literal(1), rounds: z.array(AutoRoundSchema) })
  .strict();
export type AutoRound = z.infer<typeof AutoRoundSchema>;
export type AutoRoundsResponse = z.infer<typeof AutoRoundsResponseSchema>;
