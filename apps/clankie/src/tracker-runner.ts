import { operatorAgentRoleKey } from "@clankie/protocol";
import type { ProjectReview } from "@clankie/protocol/reviews";
import type { CaptainPort } from "./captain/port.ts";
import type { TrackerRouteFence } from "./mcp-host.ts";

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
  repoForProject: (projectId: string, fence?: TrackerRouteFence) => Promise<string | undefined>,
  fence?: TrackerRouteFence,
): Promise<string | undefined> {
  const project = /^project:(.+)$/u.exec(principalId)?.[1];
  if (project !== undefined) return repoForProject(project, fence);
  const match = /^fleet:([^:]+):pane:(.+)$/u.exec(principalId);
  if (!match || match[2] === "unverified") return undefined;
  // Only the hire's project decides the route; a relaunch into the same project keeps it.
  const hired = () => {
    const hire = candidate(match[1]!, match[2]!);
    return hire.state === "confirmed" ? hire.projectId : undefined;
  };
  const projectId = hired();
  fence?.(() => {
    if (hired() !== projectId) throw new Error("The worker's project hire changed");
  });
  return projectId === undefined ? undefined : repoForProject(projectId, fence);
}

/**
 * A delegated principal's tracker role (LOCAL-VUH-45): reviewer when its confirmed hire
 * holds its project's review seat or role (ADR 0287), or was hired as a reviewer; any
 * other principal is a worker. Both inputs are host records, never the caller's claim.
 */
export async function trackerRoleForPrincipal(
  principalId: string,
  candidate: (fleet: string, pane: string) => ReturnType<CaptainPort["projectHireMembershipCandidate"]>,
  review: (projectId: string) => Promise<ProjectReview | undefined>,
): Promise<"worker" | "reviewer"> {
  const match = /^fleet:([^:]+):pane:(.+)$/u.exec(principalId);
  if (!match || match[2] === "unverified") return "worker";
  const hire = candidate(match[1]!, match[2]!);
  if (hire.state !== "confirmed") return "worker";
  const role = operatorAgentRoleKey(hire.role ?? "");
  if (role === operatorAgentRoleKey("reviewer")) return "reviewer";
  const policy = await review(hire.projectId);
  return policy !== undefined &&
    ("seat" in policy ? policy.seat === hire.seat : role !== "" && operatorAgentRoleKey(policy.role) === role)
    ? "reviewer"
    : "worker";
}

/**
 * A delegated worker's display name in the tracker (LOCAL-VUH-59): the persona bound to the
 * exact seat and session its confirmed hire recorded, such as Lark, or that seat when no
 * persona is bound. Undefined for any other principal. Never from tool arguments; the
 * principal stays the actor id.
 */
export function trackerWorkerNameForPrincipal(
  principalId: string,
  candidate: (fleet: string, pane: string) => ReturnType<CaptainPort["projectHireMembershipCandidate"]>,
  personaName: (seatId: string, occupantId: string) => string | undefined,
): string | undefined {
  const match = /^fleet:([^:]+):pane:(.+)$/u.exec(principalId);
  if (!match || match[2] === "unverified") return undefined;
  const hire = candidate(match[1]!, match[2]!);
  if (hire.state !== "confirmed") return undefined;
  // Live seat ids qualify the seat with its fleet outside the default one; a remote hire records
  // its seat already qualified, as pc/term_….
  const fleet = match[1]!;
  const seatId =
    fleet === "default" || hire.seat.startsWith(`${fleet}/`) ? hire.seat : `${fleet}/${hire.seat}`;
  return personaName(seatId, hire.nativeOccupantId) ?? hire.seat;
}
