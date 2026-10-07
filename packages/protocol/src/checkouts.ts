import { z } from "zod";

/** A worktree's work compared with main by patch content (`git cherry`), plus uncommitted files. */
export const WorktreeReconciliationSchema = z
  .object({
    path: z.string(),
    state: z.enum(["reconciled", "unreconciled", "unknown"]),
    branch: z.string().optional(),
    head: z.string().optional(),
    unlandedCommits: z.number().int().nonnegative().optional(),
    dirtyFiles: z.number().int().nonnegative().optional(),
    lastActivityAt: z.string().datetime().optional(),
    reason: z.string().max(512).optional(),
  })
  .strict();
export type WorktreeReconciliation = z.infer<typeof WorktreeReconciliationSchema>;
/** The lead's recorded judgment about unlanded work; deletion of unlanded work requires one. */
export const WorktreeDecisionKindSchema = z.enum(["worth_landing", "safe_to_drop", "closed_unreconciled"]);
export const WorktreeDecisionSchema = z
  .object({
    id: z.string().uuid(),
    at: z.string().datetime(),
    path: z.string().min(1).max(4096),
    head: z.string().optional(),
    decision: WorktreeDecisionKindSchema,
    reason: z.string().min(1).max(512),
    by: z.string().min(1).max(512),
    unlandedCommits: z.number().int().nonnegative().optional(),
    dirtyFiles: z.number().int().nonnegative().optional(),
  })
  .strict();
export type WorktreeDecision = z.infer<typeof WorktreeDecisionSchema>;
export const UnreconciledWorktreeSchema = WorktreeReconciliationSchema.extend({
  owner: z.string(),
  ageSeconds: z.number().int().nonnegative().optional(),
  decision: WorktreeDecisionSchema.optional(),
}).strict();
export type UnreconciledWorktree = z.infer<typeof UnreconciledWorktreeSchema>;

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
    /** Linked worktrees holding commits not on main by content, or uncommitted files; oldest first. */
    unreconciled: z.array(UnreconciledWorktreeSchema).optional(),
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
