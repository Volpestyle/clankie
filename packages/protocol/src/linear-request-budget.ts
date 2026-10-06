import { z } from "zod";

export const LINEAR_REQUEST_BUDGET_PATH = "/v1/linear/request-budget";
export const LinearRequestBudgetAccountSchema = z.object({
  accountId: z.string(),
  workspaceId: z.string().optional(),
  userId: z.string().optional(),
  requests: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  used: z.number().int().nonnegative(),
  utilization: z.number().nonnegative(),
  status: z.enum(["normal", "warning", "throttled", "limited"]),
  backgroundMinIntervalMs: z.number().int().nonnegative(),
  backgroundRetryAt: z.number().int().nonnegative().optional(),
  requestsRemaining: z.number().int().nonnegative().optional(),
  resetAt: z.number().int().nonnegative().optional(),
});
export const LinearRequestBudgetReportSchema = z.object({
  schemaVersion: z.literal(1),
  windowMs: z.literal(3_600_000),
  observedAt: z.number().int().nonnegative(),
  accounts: z.array(LinearRequestBudgetAccountSchema),
});
export type LinearRequestBudgetAccount = z.infer<typeof LinearRequestBudgetAccountSchema>;
export type LinearRequestBudgetReport = z.infer<typeof LinearRequestBudgetReportSchema>;
