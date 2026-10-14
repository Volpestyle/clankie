import { z } from "zod";

/** Full stable builtin keys and imported/default keys; never compare a stripped suffix. */
export const SeatEfficiencyIssueKeyPattern = "^(?:[A-Z][A-Z0-9]*-[0-9]+|LOCAL-[A-Z][A-Z0-9]*-[1-9][0-9]*)$";
export const SeatEfficiencyIssueKeySchema = z.string().regex(new RegExp(SeatEfficiencyIssueKeyPattern, "u"));

/** Observed evidence for the owning lead to review; flags never control a worker. */
export const OperatorSeatEfficiencySchema = z
  .object({
    checkedAt: z.string().datetime(),
    ownerConversationId: z.string().min(1).max(256),
    flags: z.array(z.string().min(1).max(128)).max(12),
    /** Time of an explicit deliverable assignment, never refreshed by ordinary messages. */
    deliverableAssignedAt: z.string().datetime().optional(),
    assignedDeliverable: z.string().min(1).max(16_384).optional(),
    objective: z.string().min(1).max(16_384).optional(),
    /** Issue assignments explicitly reported live by the lead, including native children. */
    ownedIssues: z.array(SeatEfficiencyIssueKeySchema).max(100).optional(),
    currentIssue: z.string().min(1).max(64).optional(),
    model: z.string().min(1).max(256).optional(),
    effort: z.string().min(1).max(64).optional(),
    /** Latest native context occupancy, never lifetime or summed turn usage. */
    contextPercent: z.number().finite().min(0).max(100).optional(),
    lastProgressAt: z.string().datetime().optional(),
    lastReportAt: z.string().datetime().optional(),
    reportFailures: z.number().int().nonnegative().optional(),
    /** When the owning lead's latest review was recorded: the receipt an aborted review reconciles against. */
    reviewedAt: z.string().datetime().optional(),
  })
  .strict();
export type OperatorSeatEfficiency = z.infer<typeof OperatorSeatEfficiencySchema>;
