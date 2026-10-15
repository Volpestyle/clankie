import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Project, ProjectStatus } from "@clankie/protocol/projects";
import type { ProjectMirrors } from "./project-mirrors.ts";
import { originDefaultBranch } from "./repository-churn.ts";

const run = promisify(execFile);

/** How long an unchanged Auto round waits before waking Clankie again (ADR 0264). */
const AUTO_IDLE_REWAKE_MS = 2 * 60 * 60_000;

export interface AutoProjectState {
  readonly id: string;
  readonly name: string;
  readonly focus?: string;
  readonly trackerProjectId?: string;
  readonly linearProjectBinding?: Project["linearProjectBinding"];
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
function autoProjectStates(
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
      ...(project.linearProjectBinding === undefined
        ? {}
        : { linearProjectBinding: project.linearProjectBinding }),
      workers: countInside(project, seatDirectories),
    }));
}

/** Explicit tracker ownership wins; assigned leads never take another project by workspace. */
export function autoProjectRounds(
  projects: readonly Project[],
  seatDirectories: readonly string[],
  leads: readonly {
    conversationId: string;
    workspace: string;
    machine: string;
    projects: readonly { id: string }[];
  }[],
  defaultConversationId: string,
): Map<string, AutoProjectState[]> {
  const rounds = new Map<string, AutoProjectState[]>();
  for (const state of autoProjectStates(projects, seatDirectories)) {
    const project = projects.find((candidate) => candidate.id === state.id)!;
    const boundIds = [project.trackerProjectId, project.linearProjectBinding?.projectId];
    const explicit = leads.filter((lead) => lead.projects.some((entry) => boundIds.includes(entry.id)));
    const matches = explicit.length
      ? explicit
      : leads.filter(
          (lead) =>
            lead.conversationId !== defaultConversationId &&
            lead.projects.length === 0 &&
            project.workspaces.some(
              (workspace) => workspace.machineId === lead.machine && workspace.path === lead.workspace,
            ),
        );
    const conversationId = matches.length === 1 ? matches[0]!.conversationId : defaultConversationId;
    const group = rounds.get(conversationId) ?? [];
    group.push(state);
    rounds.set(conversationId, group);
  }
  return rounds;
}

/**
 * Commits that reached each repository's origin default branch since `since`, as
 * last fetched; shared history counts once. Undefined when no repository has one.
 */
async function landedSince(repositories: readonly string[], since: Date): Promise<number | undefined> {
  const commits = new Set<string>();
  let read = false;
  for (const repository of repositories) {
    const branch = await originDefaultBranch(repository);
    if ("reason" in branch) continue;
    const listed = await run(
      "git",
      ["-C", repository, "rev-list", `--since=${since.toISOString()}`, branch.head, "--"],
      { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
    ).catch(() => undefined);
    if (listed === undefined) continue;
    read = true;
    for (const commit of listed.stdout.split("\n")) if (commit) commits.add(commit);
  }
  return read ? commits.size : undefined;
}

/**
 * Every project's status line; `questionWorkspaces` holds one entry per pending owner question.
 * Landings come from the local workspaces, or a remote-only project's mirror as last fetched.
 */
export async function projectStatuses(
  projects: readonly Project[],
  seatDirectories: readonly string[],
  questionWorkspaces: readonly (string | undefined)[],
  now = new Date(),
  mirrors?: Pick<ProjectMirrors, "history">,
): Promise<Record<string, ProjectStatus>> {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const statuses: Record<string, ProjectStatus> = {};
  for (const project of projects) {
    const history = mirrors
      ? await mirrors.history(project)
      : ({
          state: "readable",
          source: "workspace",
          repositories: project.workspaces
            .filter((workspace) => workspace.machineId === "local")
            .map((workspace) => workspace.path),
        } as const);
    const landedToday =
      history.state === "readable" ? await landedSince(history.repositories, midnight) : undefined;
    statuses[project.id] = {
      agentsWorking: countInside(project, seatDirectories),
      ...(landedToday === undefined ? {} : { landedToday }),
      needsYou: countInside(project, questionWorkspaces),
    };
  }
  return statuses;
}

/**
 * What changes the round's evidence; an unchanged round waits out the idle rewake. Drift
 * contributes its signal set per project, not counts, so new drift wakes the lead promptly
 * and unchanged drift costs no extra turns (ADR 0270).
 */
export function autoRoundFingerprint(
  states: readonly AutoProjectState[],
  driftSignals: (projectId: string) => readonly string[] = () => [],
): string {
  return JSON.stringify(
    states.map((state) => [
      state.id,
      state.focus ?? "",
      state.workers,
      state.trackerProjectId ?? "",
      state.linearProjectBinding?.projectId ?? "",
      ...(driftSignals(state.id).length ? [driftSignals(state.id)] : []),
    ]),
  );
}

export function autoRoundDue(
  fingerprint: string,
  last: { fingerprint: string; at: number } | undefined,
  now: number,
  idleRewakeMs = AUTO_IDLE_REWAKE_MS,
): boolean {
  return last === undefined || last.fingerprint !== fingerprint || now - last.at >= idleRewakeMs;
}

/**
 * The wake text. Names and focus lines are owner-authored settings, so they read as the owner's;
 * velocity lines are the service's own measurements (ADR 0270).
 */
export function autoRoundPrompt(
  states: readonly AutoProjectState[],
  velocity: readonly string[] = [],
  drift: readonly string[] = [],
): string {
  return [
    "Auto round. The owner put these projects on Auto: work their backlogs without being asked.",
    "For each one, read its tracker with the linear_* tools, take the next ready work in priority order, plan it into issues where it needs planning, and staff it within the project's worker cap and the machine and account limits. Land finished work and close it with evidence, and file what you find along the way.",
    "A Linear project reference names that exact project in the connected Linear app. Read its backlog by UUID; it does not switch a repository’s saved tracker backend or grant access to another account.",
    "Your autonomy settings decide which calls you make alone. Bring the owner only decisions that are truly his, one owner ask each. If a project is blocked or its backlog is empty, record that once and move on; do not message the owner just to say so.",
    "",
    "Projects on Auto (owner settings):",
    ...states.map(
      (state) =>
        `- ${state.name} (${state.id}): ${state.focus === undefined ? "no focus set" : `focus: ${state.focus}`}; built-in tracker project: ${state.trackerProjectId ?? "none bound"}; Linear project: ${state.linearProjectBinding?.projectId ?? "none bound"}; workers in its workspaces now: ${state.workers}`,
    ),
    ...(velocity.length
      ? [
          "",
          "Velocity since each project's last milestone (measured by the service):",
          ...velocity.map((line) => `- ${line}`),
        ]
      : []),
    ...drift,
  ].join("\n");
}
