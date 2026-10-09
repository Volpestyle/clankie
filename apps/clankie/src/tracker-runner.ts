import type { CaptainPort } from "./captain/port.ts";

/**
 * The live link behind a run's actor (VUH-1918): a fleet worker's principal names its
 * fleet and pane, and the hire records name its seat, harness and hire revision. Nothing
 * is copied into the tracker; a worker that is gone simply reads as no longer hired.
 */
export function trackerRunner(
  principalId: string,
  candidate: (fleet: string, pane: string) => ReturnType<CaptainPort["projectHireMembershipCandidate"]>,
): Record<string, unknown> | undefined {
  const match = /^fleet:([^:]+):pane:(.+)$/u.exec(principalId);
  if (!match) return undefined;
  // A pane the host could not verify links to its fleet only; it cannot name a hire.
  if (match[2] === "unverified") return { fleet: match[1], hired: "unverified" };
  const hire = candidate(match[1]!, match[2]!);
  return {
    fleet: match[1],
    pane: match[2],
    hired: hire.state,
    ...(hire.state === "confirmed"
      ? { seat: hire.seat, harness: hire.harness, hireRevision: hire.revision }
      : {}),
  };
}
