import { z } from "zod";

/**
 * Per-actor budgets on Clankie's own tracker tools (LOCAL-VUH-45, ADR 0216/0217
 * amendment). Each hired worker has an interactive and a background class; the
 * owner and Clankie are never limited. Refusals of a role's verbs are counted here
 * too, since they are recorded host-side rather than in the tracker's audit log.
 */
export const TRACKER_REQUEST_BUDGET_PATH = "/v1/tracker/request-budget";
export const TrackerRequestBudgetClassSchema = z.object({
  requests: z.number().int().nonnegative(),
  requestLimit: z.number().int().positive(),
  writes: z.number().int().nonnegative(),
  writeLimit: z.number().int().positive(),
  /** Set while the class is refusing: when its oldest counted call leaves the window. */
  retryAt: z.number().int().nonnegative().optional(),
});
export const TrackerRequestBudgetActorSchema = z.object({
  actorId: z.string(),
  name: z.string().optional(),
  role: z.enum(["worker", "reviewer"]).optional(),
  interactive: TrackerRequestBudgetClassSchema,
  background: TrackerRequestBudgetClassSchema,
  /** Refusals in the request window, by reason. */
  refusals: z.object({
    role_not_allowed: z.number().int().nonnegative(),
    tracker_request_budget: z.number().int().nonnegative(),
  }),
});
export const TrackerRequestBudgetReportSchema = z.object({
  schemaVersion: z.literal(1),
  requestWindowMs: z.literal(3_600_000),
  writeWindowMs: z.literal(60_000),
  observedAt: z.number().int().nonnegative(),
  actors: z.array(TrackerRequestBudgetActorSchema),
});
export type TrackerRequestBudgetActor = z.infer<typeof TrackerRequestBudgetActorSchema>;
export type TrackerRequestBudgetReport = z.infer<typeof TrackerRequestBudgetReportSchema>;
