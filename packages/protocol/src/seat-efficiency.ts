import { z } from "zod";

/** Observed evidence for the owning lead to review; flags never control a worker. */
export const OperatorSeatEfficiencySchema = z
  .object({
    checkedAt: z.string().datetime(),
    ownerConversationId: z.string().min(1).max(256),
    flags: z.array(z.string().min(1).max(128)).max(12),
    assignedDeliverable: z.string().min(1).max(16_384).optional(),
    objective: z.string().min(1).max(16_384).optional(),
    currentIssue: z.string().min(1).max(64).optional(),
    model: z.string().min(1).max(256).optional(),
    effort: z.string().min(1).max(64).optional(),
    /** Latest native context occupancy, never lifetime or summed turn usage. */
    contextPercent: z.number().finite().min(0).max(100).optional(),
    lastProgressAt: z.string().datetime().optional(),
    lastReportAt: z.string().datetime().optional(),
    reportFailures: z.number().int().nonnegative().optional(),
  })
  .strict();
export type OperatorSeatEfficiency = z.infer<typeof OperatorSeatEfficiencySchema>;
