import { z } from "zod";

export const ISSUE_METRICS_PATH = "/v1/captain/issue-metrics";
const Count = z.number().int().nonnegative();
export const IssueMetricsQuerySchema = z
  .object({
    since: z.string().datetime({ offset: true }).optional(),
    until: z.string().datetime({ offset: true }).optional(),
    issue: z
      .string()
      .regex(/^[A-Z][A-Z0-9]*-\d+$/u)
      .optional(),
    worker: z.string().min(1).max(200).optional(),
  })
  .strict();
export type IssueMetricsQuery = z.infer<typeof IssueMetricsQuerySchema>;
const Totals = {
  reportedTokens: Count.nullable(),
  usageReports: Count,
  fullCheckRuns: Count.nullable(),
  reviewRounds: Count.nullable(),
  reworkRounds: Count.nullable(),
};
const WorkerIssue = z.object({
  workerId: z.string(),
  label: z.string(),
  nativeSessionId: z.string(),
  startedAt: z.string().datetime(),
  acceptedAt: z.string().datetime().nullable(),
  wallTimeMs: Count.nullable(),
  ...Totals,
  seatSettlements: z.object({ passed: Count, failed: Count, prompt: Count, ship: Count }),
  unresolvedHireReceipt: z.boolean(),
});
export const IssueMetricsReportSchema = z.object({
  schemaVersion: z.literal(1),
  window: z.object({ since: z.string().datetime(), until: z.string().datetime() }),
  issues: z.array(
    z.object({
      issueId: z.string(),
      status: z.enum(["accepted", "in_progress"]),
      startedAt: z.string().datetime(),
      acceptedAt: z.string().datetime().nullable(),
      wallTimeMs: Count.nullable(),
      ...Totals,
      leadReportedTokens: Count.nullable(),
      leadUsageReports: Count,
      workers: z.array(WorkerIssue),
    }),
  ),
  workers: z.array(
    z.object({
      workerId: z.string(),
      label: z.string(),
      issueIds: z.array(z.string()),
      wallTimeMs: Count.nullable(),
      ...Totals,
    }),
  ),
  coverage: z.object({
    tokens: z.string(),
    wallTime: z.string(),
    fullChecks: z.string(),
    reviews: z.string(),
    warnings: z.array(z.string()),
  }),
});
export type IssueMetricsReport = z.infer<typeof IssueMetricsReportSchema>;
