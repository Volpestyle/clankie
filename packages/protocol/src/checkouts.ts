import { z } from "zod";

export const CheckoutStatusSchema = z
  .object({
    path: z.string(),
    outcome: z.enum(["observed", "unavailable"]),
    branch: z.string().optional(),
    head: z.string().optional(),
    remoteMain: z.string().optional(),
    ahead: z.number().int().nonnegative().optional(),
    behind: z.number().int().nonnegative().optional(),
    dirty: z.boolean().optional(),
    staleWorktrees: z.number().int().nonnegative().optional(),
    linkedWorktrees: z.number().int().nonnegative().optional(),
    reason: z.string().optional(),
  })
  .strict();
export type CheckoutStatus = z.infer<typeof CheckoutStatusSchema>;
export const CheckoutReportSchema = z
  .object({
    observedAt: z.string(),
    refFreshness: z.literal("cached-origin/main"),
    checkouts: z.array(CheckoutStatusSchema),
  })
  .strict();
export type CheckoutReport = z.infer<typeof CheckoutReportSchema>;

export const CheckoutSyncResultSchema = z
  .object({
    path: z.string(),
    outcome: z.enum(["current", "updated", "blocked", "unavailable"]),
    before: z.string().optional(),
    after: z.string().optional(),
    reason: z.string().optional(),
    blockers: z.array(
      z.object({ path: z.string(), ageSeconds: z.number().nonnegative().optional() }).strict(),
    ),
  })
  .strict();
