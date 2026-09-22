import { z } from "zod";

export const EVALUATOR_PATH = "/v1/captain/evaluator";
export const EvaluatorHarnessSchema = z.enum(["codex", "claude"]);
export const EvaluatorCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("enable"), harness: EvaluatorHarnessSchema.optional() }).strict(),
  z.object({ action: z.literal("disable") }).strict(),
  z.object({ action: z.literal("open") }).strict(),
  z.object({ action: z.literal("retry"), id: z.string().uuid() }).strict(),
]);
export type EvaluatorCommand = z.infer<typeof EvaluatorCommandSchema>;

const AssessmentSchema = z
  .object({
    verdict: z.enum(["good", "mixed", "poor", "unknown"]),
    evidence: z.array(z.string().min(1).max(2000)).min(1).max(20),
  })
  .strict();

export const EvaluationReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    evaluationId: z.string().uuid(),
    taskOutcome: z.enum(["succeeded", "failed", "ongoing", "not_a_task", "unknown"]),
    summary: z.string().min(1).max(4000),
    outcome: AssessmentSchema,
    efficiency: AssessmentSchema,
    tools: AssessmentSchema,
    harness: AssessmentSchema,
    findings: z
      .array(
        z
          .object({
            fingerprint: z.string().min(1).max(200),
            summary: z.string().min(1).max(2000),
            evidence: z.array(z.string().min(1).max(2000)).min(1).max(20),
            confidence: z.enum(["low", "medium", "high"]),
            nextCheck: z.string().min(1).max(2000),
            state: z.enum(["observed", "issue_created", "mr_open", "applied", "validated"]),
            issueUrl: z.string().url().optional(),
            mergeRequestUrl: z.string().url().optional(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export type EvaluationReport = z.infer<typeof EvaluationReportSchema>;

export const EvaluationJobSchema = z
  .object({
    id: z.string().uuid(),
    taskId: z.string().min(1),
    conversationId: z.string().min(1),
    runIds: z.array(z.string()),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    status: z.enum(["queued", "running", "completed", "failed"]),
    directory: z.string().min(1),
    startedAt: z.string().datetime().optional(),
    error: z.string().optional(),
    report: EvaluationReportSchema.optional(),
  })
  .strict();
export type EvaluationJob = z.infer<typeof EvaluationJobSchema>;

export const EvaluatorStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    enabled: z.boolean(),
    harness: EvaluatorHarnessSchema,
    directory: z.string(),
    paneId: z.string().optional(),
    error: z.string().optional(),
    queued: z.number().int().nonnegative(),
    jobs: z.array(EvaluationJobSchema).max(50),
  })
  .strict();
export type EvaluatorStatus = z.infer<typeof EvaluatorStatusSchema>;
