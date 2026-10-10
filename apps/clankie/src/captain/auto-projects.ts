import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Project, ProjectStatus } from "@clankie/protocol/projects";

const run = promisify(execFile);

/** How long an unchanged Auto round waits before waking Clankie again (ADR 0264). */
const AUTO_IDLE_REWAKE_MS = 2 * 60 * 60_000;

export interface AutoProjectState {
  readonly id: string;
  readonly name: string;
  readonly focus?: string;
  readonly trackerProjectId?: string;
  /** Live seats working in one of the project's local workspaces or worktree roots. */
  readonly workers: number;
}

function localRoots(project: Project): string[] {
  return [...project.workspaces, ...project.worktreeRoots]
    .filter((root) => root.machineId === "local")
    .map((root) => root.path.replace(/\/+$/u, ""));
}

function countInside(project: Project, directories: readonly (string | undefined)[]): number {
  const roots = localRoots(project);
  return directories.filter(
    (directory) =>
      directory !== undefined && roots.some((root) => directory === root || directory.startsWith(`${root}/`)),
  ).length;
}

/** Projects on Auto with the live seats working in each; remote workspaces are their own lead's to count. */
export function autoProjectStates(
  projects: readonly Project[],
  seatDirectories: readonly string[],
): AutoProjectState[] {
  return projects
    .filter((project) => project.auto === true)
    .map((project) => ({
      id: project.id,
      name: project.name,
      ...(project.focus === undefined ? {} : { focus: project.focus }),
      ...(project.trackerProjectId === undefined ? {} : { trackerProjectId: project.trackerProjectId }),
      workers: countInside(project, seatDirectories),
    }));
}

/**
 * Commits that reached each local workspace's origin default branch since `since`,
 * as last fetched; shared history counts once. Undefined when no workspace has one.
 */
async function landedSince(project: Project, since: Date): Promise<number | undefined> {
  const commits = new Set<string>();
  let read = false;
  for (const workspace of project.workspaces) {
    if (workspace.machineId !== "local") continue;
    for (const ref of ["origin/HEAD", "origin/main"]) {
      const listed = await run(
        "git",
        ["-C", workspace.path, "rev-list", `--since=${since.toISOString()}`, ref, "--"],
        { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
      ).catch(() => undefined);
      if (listed === undefined) continue;
      read = true;
      for (const commit of listed.stdout.split("\n")) if (commit) commits.add(commit);
      break;
    }
  }
  return read ? commits.size : undefined;
}

/** Every project's status line; `questionWorkspaces` holds one entry per pending owner question. */
export async function projectStatuses(
  projects: readonly Project[],
  seatDirectories: readonly string[],
  questionWorkspaces: readonly (string | undefined)[],
  now = new Date(),
): Promise<Record<string, ProjectStatus>> {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const statuses: Record<string, ProjectStatus> = {};
  for (const project of projects) {
    const landedToday = await landedSince(project, midnight);
    statuses[project.id] = {
      agentsWorking: countInside(project, seatDirectories),
      ...(landedToday === undefined ? {} : { landedToday }),
      needsYou: countInside(project, questionWorkspaces),
    };
  }
  return statuses;
}

/** What changes the round's evidence; an unchanged round waits out the idle rewake. */
export function autoRoundFingerprint(states: readonly AutoProjectState[]): string {
  return JSON.stringify(states.map((state) => [state.id, state.focus ?? "", state.workers]));
}

export function autoRoundDue(
  fingerprint: string,
  last: { fingerprint: string; at: number } | undefined,
  now: number,
  idleRewakeMs = AUTO_IDLE_REWAKE_MS,
): boolean {
  return last === undefined || last.fingerprint !== fingerprint || now - last.at >= idleRewakeMs;
}

/** The wake text. Names and focus lines are owner-authored settings, so they read as the owner's. */
export function autoRoundPrompt(states: readonly AutoProjectState[]): string {
  return [
    "Auto round. The owner put these projects on Auto: work their backlogs without being asked.",
    "For each one, read its tracker with the linear_* tools, take the next ready work in priority order, plan it into issues where it needs planning, and staff it within the project's worker cap and the machine and account limits. Land finished work and close it with evidence, and file what you find along the way.",
    "Your autonomy settings decide which calls you make alone. Bring the owner only decisions that are truly his, one owner ask each. If a project is blocked or its backlog is empty, record that once and move on; do not message the owner just to say so.",
    "",
    "Projects on Auto (owner settings):",
    ...states.map(
      (state) =>
        `- ${state.name} (${state.id}): ${state.focus === undefined ? "no focus set" : `focus: ${state.focus}`}; tracker project: ${state.trackerProjectId ?? "none bound"}; workers in its workspaces now: ${state.workers}`,
    ),
  ].join("\n");
}
