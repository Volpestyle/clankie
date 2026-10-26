import { lstatSync, realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import {
  projectWorktreeMatches,
  observeLocalProjectWorktreeRoot,
  observeLocalProjectGitWorktree,
  type ProjectsSettings,
} from "@clankie/settings";
import { TrackerWriteRefused, type LocalTrackerOptions } from "@clankie/work-items";

/** Local source reads use the issue's current host-owned project binding, never caller roots. */
export function createGuidedReviewSourceAuthorizer(options: {
  readonly projects: () => Promise<ProjectsSettings>;
  readonly localMachineId?: string;
  readonly projectsFence?: () => Promise<{ projects: ProjectsSettings; assertCurrent: () => void }>;
}): NonNullable<LocalTrackerOptions["authorizeGuidedReviewSource"]> {
  return async (issue, source) => {
    const refuse = (detail: string): never => {
      throw new TrackerWriteRefused("guided_review_source_refused", detail);
    };
    const snapshot = options.projectsFence ? await options.projectsFence() : undefined;
    const projects = snapshot?.projects ?? (await options.projects());
    const revision = JSON.stringify(projects);
    const project = projects.projects.filter((entry) => entry.trackerProjectId === issue.projectId);
    if (project.length !== 1) refuse("Issue has no unique host project source binding");
    const machine = options.localMachineId ?? "local";
    const platform = process.platform === "win32" ? "windows" : "posix";
    const namedPath = source.kind === "git" ? source.repository : source.path;
    if (!isAbsolute(namedPath)) refuse("Guided review source must be an absolute local path");
    let canonical: string;
    try {
      canonical = await realpath(namedPath);
    } catch {
      return refuse("Guided review source is unavailable");
    }
    // No symlink alias may turn a project-local name into an unrelated host read.
    if (canonical !== namedPath) refuse("Guided review source must name its canonical path");
    const contains = (root: string, path: string) => {
      const suffix = relative(root, path);
      return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
    };
    let allowedRoot: string | undefined;
    for (const workspace of project[0]!.workspaces) {
      if (workspace.machineId !== machine || workspace.platform !== platform) continue;
      let root: string;
      try {
        root = await realpath(workspace.path);
      } catch {
        continue;
      }
      if (root !== workspace.path) continue;
      if (source.kind === "git" ? canonical === root : contains(root, canonical)) {
        allowedRoot = root;
        break;
      }
    }
    if (!allowedRoot) {
      // Registered linked worktrees require the existing Git common-dir/backlink proof.
      const candidate = source.kind === "git" ? canonical : dirname(canonical);
      const matching = await projectWorktreeMatches(
        { ...projects, projects: project },
        {
          machineId: machine,
          platform,
          cwd: candidate,
        },
        observeLocalProjectWorktreeRoot,
        observeLocalProjectGitWorktree,
      );
      if (matching.includes(project[0]!.id)) {
        // The observer proves candidate containment in the registered worktree.
        allowedRoot = candidate;
      }
    }
    if (!allowedRoot)
      refuse("Source is outside the issue project's local repositories and registered worktrees");
    const identity = (path: string) => {
      const info = lstatSync(path, { bigint: true });
      return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
    };
    const pathIdentity = identity(canonical);
    const rootIdentity = identity(allowedRoot!);
    return () => {
      snapshot?.assertCurrent();
      if (
        JSON.stringify(projects) !== revision ||
        realpathSync(canonical) !== canonical ||
        identity(canonical) !== pathIdentity ||
        identity(allowedRoot!) !== rootIdentity
      )
        refuse("Guided review source authority changed during inspection");
    };
  };
}
