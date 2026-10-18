import type { OperatorFleetSnapshot } from "@clankie/protocol";
import type { FleetRosterAgent } from "@clankie/protocol/fleet-roster";
import { FLEET_PROJECT_MEMBERSHIP_BATCH_SIZE, type ProjectsSettings } from "@clankie/protocol/projects";
import { projectsRevision } from "@clankie/settings";
import type { FleetProjectMembership } from "../fleet-project-membership.ts";
import { liveSeatIssue } from "./seat-issue-status.ts";

/** Display only. Reuse membership proof; never resolve tracker data or infer a project from roster cwd. */
export async function fleetRosterWork(
  snapshot: OperatorFleetSnapshot,
  projects: ProjectsSettings,
  membership: Pick<FleetProjectMembership, "read"> | undefined,
  signal: AbortSignal,
): Promise<Map<string, Pick<FleetRosterAgent, "project" | "task" | "ownership">>> {
  const result = new Map<string, Pick<FleetRosterAgent, "project" | "task" | "ownership">>(
    snapshot.seats.map((seat) => {
      const issue = liveSeatIssue(seat).keys[0];
      // Deliverables may be free prose. Only an explicit single work-item key is a task.
      const key = issue?.trim();
      const task =
        key &&
        /^(?:[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d+|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/iu.test(key)
          ? { issue: key, title: null }
          : null;
      return [
        seat.seatId,
        {
          project: null,
          task,
          ownership: seat.owner ? (seat.owner.hired ? "hired" : "owner") : "unowned",
        } satisfies Pick<FleetRosterAgent, "project" | "task" | "ownership">,
      ] as const;
    }),
  );
  if (!membership || signal.aborted) return result;
  const revision = projectsRevision(projects);
  await Promise.all(
    Array.from(
      { length: Math.ceil(snapshot.seats.length / FLEET_PROJECT_MEMBERSHIP_BATCH_SIZE) },
      async (_, index) => {
        const seats = snapshot.seats.slice(
          index * FLEET_PROJECT_MEMBERSHIP_BATCH_SIZE,
          (index + 1) * FLEET_PROJECT_MEMBERSHIP_BATCH_SIZE,
        );
        try {
          const proof = await membership.read(
            {
              schemaVersion: 1,
              seats: seats.map((seat) => ({
                seatId: seat.seatId,
                occupantId: seat.occupantId,
                fleet: seat.fleet ?? "default",
              })),
            },
            signal,
            async () => (!signal.aborted ? true : "forbidden"),
          );
          if (signal.aborted || proof.projectsRevision !== revision) return;
          for (const seat of seats) {
            const rows = proof.seats.filter(
              (row) =>
                row.seatId === seat.seatId &&
                row.occupantId === seat.occupantId &&
                (row.fleet ?? "default") === (seat.fleet ?? "default"),
            );
            const observed = rows.length === 1 ? rows[0]?.membership : undefined;
            const project =
              observed?.outcome === "member"
                ? projects.projects.find((project) => project.id === observed.projectId)
                : undefined;
            if (project)
              result.set(seat.seatId, {
                ...result.get(seat.seatId)!,
                project: { id: project.id, name: project.name },
              });
          }
        } catch {
          // Unknown membership is null. It does not invalidate native status/count observations.
        }
      },
    ),
  );
  return result;
}
