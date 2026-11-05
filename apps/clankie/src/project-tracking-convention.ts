import type { Project, ProjectsSettings } from "@clankie/protocol/projects";
import type { WorkConvention } from "@clankie/protocol/work-items";

/** The confirmed setting supplies routing; it does not register a workspace, account or grant. */
export function projectTrackingConvention(
  project: Project,
  visibility: "public" | "private",
): WorkConvention | undefined {
  const tracking = project.tracking;
  if (!tracking || !project.trackingConfirmedAt) return undefined;
  const target = tracking.tracker;
  return {
    schemaVersion: 1,
    decidedBy: "owner",
    decidedAt: project.trackingConfirmedAt,
    note: "From the project's confirmed public/private tracking setting",
    ...(target.backend === "github"
      ? { backend: "github", github: { repo: target[visibility].repository } }
      : {
          backend: "linear",
          linear: { team: target[visibility].team, project: target[visibility].project },
        }),
  };
}
export function trackingConventionAt(projects: ProjectsSettings, path: string): WorkConvention | undefined {
  const matches = projects.projects.flatMap((project) =>
    (project.tracking?.repositories ?? [])
      .filter((repo) => repo.localPath === path)
      .map((repo) => ({ project, repo })),
  );
  if (matches.length > 1) throw new Error("More than one project owns this tracking repository");
  const match = matches[0];
  return match ? projectTrackingConvention(match.project, match.repo.visibility) : undefined;
}
