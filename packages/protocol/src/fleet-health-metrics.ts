import { z } from "zod";
import { WorkerReportBridgeReasonSchema } from "./worker-report-health.ts";

export const FLEET_HEALTH_METRICS_PATH = "/v1/fleet/metrics";
export const FleetProofRefusalReasonSchema = z.enum([
  "unsupported_platform",
  "invalid_pane",
  "closed_socket",
  "missing_binding",
  "caller_exited",
  "ancestor_exited",
  "native_initial_unavailable",
  "native_final_unavailable",
  "pane_unavailable",
  "not_member",
  "snapshot_changed",
  "pane_changed",
  "private_seat_expired",
  "binding_changed",
  "observation_failed",
]);
export type FleetProofRefusalReason = z.infer<typeof FleetProofRefusalReasonSchema>;
export const FleetNativeDiagnosticReasonSchema = z.enum([
  "clock_unavailable",
  "invalid_arguments",
  "process_census_unavailable",
  "process_census_changed",
  "allocation_failed",
  "process_unavailable",
  "process_changed",
  "fd_list_unavailable",
  "fd_list_bounds",
  "fd_record_invalid",
  "socket_unavailable",
  "socket_identity_invalid",
  "multiple_owners",
  "owner_not_found",
  "budget_exhausted",
  "owner_mismatch",
  "socket_mismatch",
  "ancestry_bounds",
  "ancestry_cycle",
  "caller_exited",
  "ancestor_exited",
  "ancestry_unavailable",
  "ancestry_changed",
  "attempts_exhausted",
  "executable_unavailable",
  "argv_unavailable",
  "argv_invalid",
  "executable_changed",
  "argv_changed",
]);
export const FleetTransportDiagnosticReasonSchema = z.enum([
  "queue_full",
  "cancelled",
  "timeout",
  "helper_unavailable",
  "protocol_invalid",
]);
const Count = z.number().int().nonnegative();
const Proof = z.strictObject({
  attempts: Count,
  refusals: Count,
  byReason: z.partialRecord(FleetProofRefusalReasonSchema, Count),
});
const Reports = z.strictObject({
  attempts: Count,
  failures: Count,
  byReason: z.partialRecord(WorkerReportBridgeReasonSchema.exclude(["stored"]), Count),
});
const Counters = {
  proof: Proof,
  reports: Reports,
  nativeDiagnostics: z.partialRecord(FleetNativeDiagnosticReasonSchema, Count),
  transportDiagnostics: z.partialRecord(FleetTransportDiagnosticReasonSchema, Count),
};
export const FleetHealthMetricsWindowSchema = z.strictObject({
  minutes: z.union([z.literal(5), z.literal(60)]),
  ...Counters,
  proofRefusalRate: z.number().min(0).max(1),
  proofRefusalsPerMinute: z.number().nonnegative(),
  reportFailureRate: z.number().min(0).max(1),
  reportFailuresPerMinute: z.number().nonnegative(),
});
export type FleetHealthMetricsWindow = z.infer<typeof FleetHealthMetricsWindowSchema>;
/** Bounded, process-local counters. A restart starts a new observation epoch. */
export const FleetHealthMetricsSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  startedAt: z.string().datetime(),
  observedAt: z.string().datetime(),
  totals: z.strictObject(Counters),
  /** Request pane claims are diagnostic labels, never proof of caller identity. */
  callers: z
    .array(
      z.strictObject({
        claimedPane: z.string().regex(/^w\w{1,64}:p\w{1,64}$/u),
        window: FleetHealthMetricsWindowSchema,
      }),
    )
    .max(512)
    .optional(),
  windows: z.tuple([FleetHealthMetricsWindowSchema, FleetHealthMetricsWindowSchema]),
});
export type FleetHealthMetricsSnapshot = z.infer<typeof FleetHealthMetricsSnapshotSchema>;
