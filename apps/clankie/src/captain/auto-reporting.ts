import type { ProjectVelocity, VelocityMilestone } from "@clankie/protocol/auto-rounds";

/** Identity survives tracker milestone renames and reopen/close cycles. */
export const milestoneKey = (milestone: VelocityMilestone): string =>
  `${milestone.kind}:${milestone.id ?? milestone.ref}`;

export function milestoneSignals(velocity: ProjectVelocity | undefined): string[] {
  if (velocity === undefined) return [];
  const cadence = velocity.ownerLoop ?? "milestones";
  const latest =
    velocity.landings?.state === "known"
      ? [...velocity.landings.commits].sort(
          (a, b) => b.at.localeCompare(a.at) || a.sha.localeCompare(b.sha),
        )[0]
      : undefined;
  return [
    ...velocity.milestones.map(milestoneKey),
    ...(velocity.autoUpdates === false
      ? []
      : (velocity.progress ?? []).map((event) => `progress:${event.key}`)),
    ...(cadence === "milestones" ? [] : [`owner-loop:${cadence}`]),
    ...(cadence === "landings" && latest ? [`landing:${latest.sha}`] : []),
  ].sort();
}

/** One request per project, even when a cleanup batch completes several milestones. */
export function reportingSection(velocities: readonly ProjectVelocity[]): string[] {
  return [
    "",
    "Project status updates (service-measured milestones and evidenced progress):",
    "For every requested update, lead with clips and stills from issue evidence using stable asset URLs and short captions, then what is open and what is next.",
    ...velocities.map((velocity) => {
      const milestones = velocity.report?.milestones ?? [];
      const landings = velocity.report?.landings ?? [];
      if ((velocity.ownerLoop ?? "milestones") === "silent")
        return `- ${velocity.name} (${velocity.projectId}): owner reports are silent. Do not request a new project status update. Measurements and drift still apply.`;
      const progress = velocity.report?.progress ?? [];
      if (progress.length)
        return `- ${velocity.name} (${velocity.projectId}): noteworthy evidenced progress: ${progress
          .slice(0, 8)
          .map((event) => `${event.issue} (${event.kind} at ${event.at}; ${event.refs.join(", ")})`)
          .join(
            "; ",
          )}${progress.length > 8 ? `; ${progress.length - 8} more evidence hints` : ""}${milestones.length ? `; milestones ${milestones.map((milestone) => milestone.ref).join(", ")}` : ""}${landings.length ? `; ${landings.length} new landings` : ""}. Review the previous update and the changed issues. Post exactly one project status update with media and evidence links for the noteworthy results since then. Lead with clips and stills from issue evidence using stable asset URLs and short captions, then what remains open and what is next. These are evidence hints, not proof of completion or permission to publish third-party media. Reconcile an uncertain write; never resend on an uncertain reply.`;
      if (landings.length)
        return `- ${velocity.name} (${velocity.projectId}): ${landings.length} new landings (${landings.map((landing) => landing.sha).join(", ")})${milestones.length ? ` and milestones ${milestones.map((milestone) => milestone.ref).join(", ")}` : ""}. Post exactly one project status update covering these events together, with media and evidence links. Read the previous update first and reconcile an uncertain write; never resend on an uncertain reply.`;
      return milestones.length
        ? `- ${velocity.name} (${velocity.projectId}): milestone reached: ${milestones.map((milestone) => `${milestone.ref} at ${milestone.at}`).join("; ")}. Post exactly one project status update covering these milestones together, with media and evidence links. Read the previous update first; link the completed issues and their evidence. Reconcile an uncertain write; never send it again just because its reply was lost.`
        : `- ${velocity.name} (${velocity.projectId}): no new milestone report is due. Do not post a project status update for this routine round. This does not cancel an earlier request.`;
    }),
  ];
}
