import { z } from "zod";

/** Content-free sender observations; never report bodies, credentials or native authority. */
export const WorkerReportBridgeReasonSchema = z.enum([
  "stored",
  "binding_timeout",
  "binding_unavailable",
  "binding_rejected",
  "receipt_unresolved",
  "receipt_timeout",
  "receipt_invalid",
  "connection_refused",
  "local_receipt_unavailable",
]);
export const WorkerReportBridgeStatusSchema = z
  .object({
    outcome: z.enum(["stored", "uncertain", "rejected", "unavailable"]),
    reason: WorkerReportBridgeReasonSchema,
    observedAt: z.string().datetime(),
    lastStoredAt: z.string().datetime().optional(),
  })
  .strict()
  .refine((report) => (report.outcome === "stored") === (report.reason === "stored"), {
    message: "Stored report outcome and reason must agree",
  })
  .refine(
    (report) =>
      report.lastStoredAt === undefined || Date.parse(report.lastStoredAt) <= Date.parse(report.observedAt),
    {
      message: "A stored report cannot follow its current observation",
    },
  );
export type WorkerReportBridgeStatus = z.infer<typeof WorkerReportBridgeStatusSchema>;
