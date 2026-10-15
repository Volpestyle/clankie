import type { ProjectVelocity, VelocityMilestone } from "@clankie/protocol/auto-rounds";

/** Identity survives tracker milestone renames and reopen/close cycles. */
export const milestoneKey = (milestone: VelocityMilestone): string =>
  `${milestone.kind}:${milestone.id ?? milestone.ref}`;

export function milestoneSignals(velocity: ProjectVelocity | undefined): string[] {
  return (velocity?.milestones ?? []).map(milestoneKey).sort();
}

/** One request per project, even when a cleanup batch completes several milestones. */
export function reportingSection(velocities: readonly ProjectVelocity[]): string[] {
  return [
    "",
    "Project status updates (service-measured milestones):",
    ...velocities.map((velocity) => {
      const milestones = velocity.report?.milestones ?? [];
      return milestones.length
        ? `- ${velocity.name} (${velocity.projectId}): milestone reached: ${milestones.map((milestone) => `${milestone.ref} at ${milestone.at}`).join("; ")}. Post exactly one project status update covering these milestones together, with media and evidence links. Read the previous update first; link the completed issues and their evidence. Reconcile an uncertain write; never send it again just because its reply was lost.`
        : `- ${velocity.name} (${velocity.projectId}): no new milestone report is due. Do not post a project status update for this routine round. This does not cancel an earlier request.`;
    }),
  ];
}
