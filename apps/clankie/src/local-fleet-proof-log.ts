import type { createLogger } from "@clankie/observability";
import type { LocalFleetProofDiagnostic } from "./local-fleet-proof.ts";
import type { FleetHealthMetrics } from "./fleet-health-metrics.ts";

/** Only the proof's fixed vocabulary crosses this log boundary; no caller/PID/path fields. */
export function localProofDiagnostics(
  logger: Pick<ReturnType<typeof createLogger>, "warn">,
  operation: "fleet" | "project",
  metrics?: Pick<FleetHealthMetrics, "observeProof">,
) {
  return (observation: LocalFleetProofDiagnostic, pane?: string) => {
    metrics?.observeProof(operation, observation, pane);
    if (observation.source === "proof_success") return;
    logger.warn(
      {
        event: observation.source === "proof" ? "fleet.local_proof.refused" : "fleet.local_proof.diagnostic",
        operation,
        ...(observation.source === "native"
          ? { source: observation.source, checkpoint: observation.checkpoint, ...observation.event }
          : observation),
      },
      "Local fleet proof observation",
    );
  };
}
