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

/**
 * The tracker repo a delegated principal's tracker call routes to when it names none
 * (VUH-2014): a `project:<id>` grant's project, or a verified fleet pane's confirmed project
 * hire. Undefined when there is no project context, or the project tracks in Linear.
 * `repoForProject` refuses (throws) when the project has no readable saved convention.
 */
export async function trackerRepoForPrincipal(
  principalId: string,
  candidate: (fleet: string, pane: string) => ReturnType<CaptainPort["projectHireMembershipCandidate"]>,
  repoForProject: (projectId: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  const project = /^project:(.+)$/u.exec(principalId)?.[1];
  if (project !== undefined) return repoForProject(project);
  const match = /^fleet:([^:]+):pane:(.+)$/u.exec(principalId);
  if (!match || match[2] === "unverified") return undefined;
  const hire = candidate(match[1]!, match[2]!);
  return hire.state === "confirmed" ? repoForProject(hire.projectId) : undefined;
}
