import { z } from "zod";

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
  .object({ kind: z.enum(["parent", "milestone"]), ref: z.string(), at: z.string() })
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

/** One project's outcomes for one Auto round. Unreadable parts are `unknown`, never zero. */
export const ProjectVelocitySchema = z
  .object({
    projectId: z.string(),
    name: z.string(),
    measuredAt: z.string(),
    timeZone: z.string(),
    window: z
      .object({ since: z.string(), until: z.string(), from: z.enum(["milestone", "lookback"]) })
      .strict(),
    lastMilestone: VelocityMilestoneSchema.nullable(),
    milestones: z.array(VelocityMilestoneSchema),
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
          cap: z.null(),
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
