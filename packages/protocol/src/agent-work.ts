import { z } from "zod";

/** A native goal is independent of whether a model turn is running. */
export const OperatorGoalStatusSchema = z.enum([
  "proposed",
  "active",
  "paused",
  "blocked",
  "budget_limited",
  "usage_limited",
  "complete",
]);
export type OperatorGoalStatus = z.infer<typeof OperatorGoalStatusSchema>;
export const OperatorGoalSchema = z
  .object({
    objective: z.string().trim().min(1).max(16_384),
    status: OperatorGoalStatusSchema,
    tokenBudget: z.number().int().positive().optional(),
    tokensUsed: z.number().int().nonnegative(),
    timeUsedSeconds: z.number().int().nonnegative().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type OperatorGoal = z.infer<typeof OperatorGoalSchema>;

/** A pointer to existing work, never another task lifecycle or tracker status. */
export const OperatorWorkAssignmentSchema = z
  .object({
    objective: z.string().trim().min(1).max(512),
    issue: z
      .object({
        repoId: z.string().regex(/^[a-z0-9-]{1,64}$/u),
        itemId: z.string().trim().min(1).max(64),
      })
      .strict()
      .optional(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type OperatorWorkAssignment = z.infer<typeof OperatorWorkAssignmentSchema>;

export const StateOperatorAgentWorkSchema = z
  .object({
    herdrPaneId: z.string().trim().min(1).max(128),
    assignment: OperatorWorkAssignmentSchema.omit({ updatedAt: true }).nullable(),
  })
  .strict();
export type StateOperatorAgentWork = z.infer<typeof StateOperatorAgentWorkSchema>;
export const StateOperatorAgentWorkResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({ outcome: z.literal("stated"), seatId: z.string(), assignment: OperatorWorkAssignmentSchema })
    .strict(),
  z.object({ outcome: z.literal("cleared"), seatId: z.string() }).strict(),
  z.object({ outcome: z.literal("unseated"), herdrPaneId: z.string() }).strict(),
]);
export type StateOperatorAgentWorkResult = z.infer<typeof StateOperatorAgentWorkResultSchema>;
