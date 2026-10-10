import type { Project } from "@clankie/protocol/projects";

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

/** Projects on Auto with the live seats working in each; remote workspaces are their own lead's to count. */
export function autoProjectStates(
  projects: readonly Project[],
  seatDirectories: readonly string[],
): AutoProjectState[] {
  return projects
    .filter((project) => project.auto === true)
    .map((project) => {
      const roots = [...project.workspaces, ...project.worktreeRoots]
        .filter((root) => root.machineId === "local")
        .map((root) => root.path.replace(/\/+$/u, ""));
      const workers = seatDirectories.filter((directory) =>
        roots.some((root) => directory === root || directory.startsWith(`${root}/`)),
      ).length;
      return {
        id: project.id,
        name: project.name,
        ...(project.focus === undefined ? {} : { focus: project.focus }),
        ...(project.trackerProjectId === undefined ? {} : { trackerProjectId: project.trackerProjectId }),
        workers,
      };
    });
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
