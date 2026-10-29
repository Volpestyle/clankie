import { z } from "zod";

export const ISSUE_METRICS_PATH = "/v1/captain/issue-metrics";
const Count = z.number().int().nonnegative();
export const IssueMetricsQuerySchema = z
  .object({
    since: z.string().datetime({ offset: true }).optional(),
    until: z.string().datetime({ offset: true }).optional(),
    issue: z
      .string()
      .regex(/^(?:LOCAL-)?[A-Z][A-Z0-9]*-\d+$/u)
      .optional(),
    project: z.string().min(1).max(200).optional(),
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
const Efficiency = {
  landedAt: z.string().datetime().nullable().optional(),
  wallTimeToLandedMs: Count.nullable().optional(),
  workerWaitMs: Count.optional(),
  waitCount: Count.optional(),
  exchanges: Count.optional(),
  reviewChangeRequests: Count.optional(),
};
const Session = z.object({
  workerId: z.string(),
  nativeSessionId: z.string(),
  harness: z.enum(["claude", "codex"]),
  hired: z.boolean(),
  startedAt: z.string().datetime(),
  lastAt: z.string().datetime(),
  observedWallTimeMs: Count,
  workerWaitMs: Count,
  waitCount: Count,
  exchanges: Count,
  reviewVerdicts: Count,
  reviewChangeRequests: Count,
});
const WorkerIssue = z.object({
  workerId: z.string(),
  label: z.string(),
  nativeSessionId: z.string(),
  startedAt: z.string().datetime(),
  acceptedAt: z.string().datetime().nullable(),
  wallTimeMs: Count.nullable(),
  ...Totals,
  ...Efficiency,
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
      ...Efficiency,
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
  sessions: z.array(Session).optional(),
  summary: z
    .object({
      workerSessions: Count,
      observedWorkerWallTimeMs: Count,
      workerWaitMs: Count,
      workerWaitShare: z.number().nonnegative().nullable(),
      waitCount: Count,
      waitsPerSession: z.number().nonnegative().nullable(),
      exchanges: Count,
      exchangesPerTask: z.number().nonnegative().nullable(),
      reviewVerdicts: Count,
      reviewChangeRequests: Count,
      reviewChangeRate: z.number().min(0).max(1).nullable(),
      leadNativeBusyMs: Count.nullable(),
      leadSettledElapsedMs: Count.nullable(),
      leadBusyMs: Count.nullable(),
      leadBusyFraction: z.number().min(0).max(1).nullable(),
      leadNativeSessions: Count,
      leadInboxVolumePerDay: z.array(z.object({ day: z.string(), count: Count })),
      current: z.object({
        observedAt: z.string().datetime(),
        inProgressCount: Count.nullable(),
        liveSeats: Count.nullable(),
        warnings: z.array(z.string()),
      }),
    })
    .optional(),
  coverage: z.object({
    missingHistories: z
      .array(
        z.object({
          machine: z.string(),
          workerId: z.string(),
          harness: z.string(),
          nativeSessionId: z.string(),
          reason: z.enum(["remote_not_collected", "not_found_or_ambiguous"]),
        }),
      )
      .optional(),
    tokens: z.string(),
    wallTime: z.string(),
    fullChecks: z.string(),
    reviews: z.string(),
    efficiency: z.string().optional(),
    warnings: z.array(z.string()),
  }),
});
export type IssueMetricsReport = z.infer<typeof IssueMetricsReportSchema>;
