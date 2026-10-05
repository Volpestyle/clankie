import type { createLogger } from "@clankie/observability";
import type { LocalFleetProofDiagnostic } from "./local-fleet-proof.ts";

/** Only the proof's fixed vocabulary crosses this log boundary; no caller/PID/path fields. */
export function localProofDiagnostics(
  logger: Pick<ReturnType<typeof createLogger>, "warn">,
  operation: "fleet" | "project",
) {
  return (observation: LocalFleetProofDiagnostic) =>
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
}
