import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ProjectsSettingsSchema,
  type ProjectWorktreeRoot,
  type ProjectsSettings,
} from "@clankie/protocol/projects";
import { projectsRevision } from "./projects.ts";

export interface ProjectWorktreeRootObservation {
  readonly path: string;
  readonly repoPath: string;
  readonly commonDirectory: string;
  readonly homePath: string;
}
export interface ProjectGitWorktreeObservation {
  readonly cwd: string;
  readonly worktreePath: string;
  readonly gitDirectory: string;
  readonly commonDirectory: string;
  readonly repoPath: string;
  readonly repoCommonDirectory: string;
  readonly registeredWorktrees: readonly string[];
  readonly gitFilePath: string;
  readonly gitDirectoryBacklink: string;
}
export type WorktreeRootRequest = Pick<ProjectWorktreeRoot, "machineId" | "platform" | "path" | "repoPath">;
export type ObserveProjectWorktreeRoot = (
  root: WorktreeRootRequest,
) => Promise<ProjectWorktreeRootObservation | undefined>;
export type ObserveProjectGitWorktree = (
  root: ProjectWorktreeRoot,
  cwd: string,
) => Promise<ProjectGitWorktreeObservation | undefined>;

export function canonicalProjectPath(path: string, platform: "posix" | "windows"): boolean {
  const paths = platform === "windows" ? win32 : posix;
  return (
    paths.isAbsolute(path) &&
    paths.normalize(path) === path &&
    !path.includes("\0") &&
    !path.includes("\r") &&
    !path.includes("\n") &&
    (platform !== "windows" || /^[A-Z]:\\/u.test(path))
  );
}
export function projectPathContains(
  parent: string,
  child: string,
  platform: "posix" | "windows",
  strict = false,
): boolean {
  if (!canonicalProjectPath(parent, platform) || !canonicalProjectPath(child, platform)) return false;
  const sep = platform === "windows" ? "\\" : "/";
  return (!strict && parent === child) || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

export function validateProjectWorktreeRoot(
  root: WorktreeRootRequest,
  observed: ProjectWorktreeRootObservation,
): boolean {
  const paths = root.platform === "windows" ? win32 : posix;
  return (
    root.path !== paths.parse(root.path).root &&
    observed.path === root.path &&
    observed.repoPath === root.repoPath &&
    Object.values(observed).every((path) => canonicalProjectPath(path, root.platform)) &&
    !projectPathContains(root.path, root.repoPath, root.platform) &&
    !projectPathContains(root.path, observed.homePath, root.platform) &&
    !projectPathContains(root.path, observed.commonDirectory, root.platform) &&
    !projectPathContains(observed.commonDirectory, root.path, root.platform)
  );
}

/** Facts must be fresh host observations, never bridge input or owner-authored Git claims. */
export function matchesProjectWorktree(
  root: ProjectWorktreeRoot,
  cwd: string,
  observed: ProjectGitWorktreeObservation,
): boolean {
  return (
    projectPathContains(root.path, observed.worktreePath, root.platform, true) &&
    matchesRepositoryWorktree(root, cwd, observed)
  );
}

function matchesRepositoryWorktree(
  root: ProjectWorktreeRoot,
  cwd: string,
  observed: ProjectGitWorktreeObservation,
): boolean {
  const paths = root.platform === "windows" ? win32 : posix;
  const allPaths = [
    cwd,
    root.path,
    root.repoPath,
    root.commonDirectory,
    observed.cwd,
    observed.worktreePath,
    observed.gitDirectory,
    observed.commonDirectory,
    observed.repoPath,
    observed.repoCommonDirectory,
    observed.gitFilePath,
    observed.gitDirectoryBacklink,
    ...observed.registeredWorktrees,
  ];
  return (
    allPaths.every((path) => canonicalProjectPath(path, root.platform)) &&
    observed.cwd === cwd &&
    observed.repoPath === root.repoPath &&
    observed.commonDirectory === root.commonDirectory &&
    observed.repoCommonDirectory === root.commonDirectory &&
    paths.dirname(observed.gitDirectory) === paths.join(root.commonDirectory, "worktrees") &&
    observed.gitFilePath === paths.join(observed.worktreePath, ".git") &&
    observed.gitDirectoryBacklink === observed.gitFilePath &&
    projectPathContains(observed.worktreePath, cwd, root.platform) &&
    observed.registeredWorktrees.includes(observed.worktreePath)
  );
}

export function addProjectWorktreeRoot(
  settings: ProjectsSettings,
  input: WorktreeRootRequest & { projectId: string; expectedRevision: string },
  observation: ProjectWorktreeRootObservation,
): ProjectsSettings {
  if (projectsRevision(settings) !== input.expectedRevision) throw new Error("Project settings changed");
  const project = settings.projects.find((entry) => entry.id === input.projectId);
  if (
    !project?.workspaces.some(
      (workspace) =>
        workspace.path === input.repoPath &&
        workspace.machineId === input.machineId &&
        workspace.platform === input.platform,
    )
  )
    throw new Error("Repo must exactly match an approved workspace in this project");
  if (!validateProjectWorktreeRoot(input, observation))
    throw new Error("Unsafe or noncanonical worktree root");
  for (const other of settings.projects) {
    for (const approved of [...other.workspaces, ...other.worktreeRoots]) {
      if (approved.machineId !== input.machineId || approved.platform !== input.platform) continue;
      const overlaps =
        projectPathContains(approved.path, input.path, input.platform) ||
        projectPathContains(input.path, approved.path, input.platform);
      if (
        overlaps &&
        (other.id !== project.id || other.worktreeRoots.includes(approved as ProjectWorktreeRoot))
      )
        throw new Error("Worktree root overlaps an existing project namespace");
    }
  }
  const id = `root-${createHash("sha256")
    .update(JSON.stringify([input.machineId, input.platform, input.path]))
    .digest("hex")
    .slice(0, 48)}`;
  const root = {
    id,
    machineId: input.machineId,
    platform: input.platform,
    path: input.path,
    repoPath: input.repoPath,
    commonDirectory: observation.commonDirectory,
  };
  return ProjectsSettingsSchema.parse({
    ...settings,
    projects: settings.projects.map((entry) =>
      entry.id === project.id ? { ...entry, worktreeRoots: [...entry.worktreeRoots, root] } : entry,
    ),
  });
}

export function removeProjectWorktreeRoot(
  settings: ProjectsSettings,
  input: { projectId: string; rootId: string; expectedRevision: string },
): ProjectsSettings {
  if (projectsRevision(settings) !== input.expectedRevision) throw new Error("Project settings changed");
  const project = settings.projects.find((entry) => entry.id === input.projectId);
  if (!project?.worktreeRoots.some((root) => root.id === input.rootId))
    throw new Error("Unknown worktree root");
  return ProjectsSettingsSchema.parse({
    ...settings,
    projects: settings.projects.map((entry) =>
      entry.id === project.id
        ? { ...entry, worktreeRoots: entry.worktreeRoots.filter((root) => root.id !== input.rootId) }
        : entry,
    ),
  });
}

/** A bad registration denies itself, not every other project. Re-observe both ends before admitting. */
export async function projectWorktreeMatches(
  settings: ProjectsSettings,
  input: { machineId: string; platform: "posix" | "windows"; cwd: string },
  observeRoot: ObserveProjectWorktreeRoot,
  observeGit: ObserveProjectGitWorktree,
): Promise<readonly string[]> {
  return matchingProjectWorktrees(settings, input, observeRoot, observeGit, true);
}

/** Owner-authenticated policy lookup only; placement does not enroll a native agent. */
export async function projectWorktreePolicyMatches(
  settings: ProjectsSettings,
  input: { machineId: string; platform: "posix" | "windows"; cwd: string },
  observeRoot: ObserveProjectWorktreeRoot,
  observeGit: ObserveProjectGitWorktree,
): Promise<readonly string[]> {
  return matchingProjectWorktrees(settings, input, observeRoot, observeGit, false);
}

async function matchingProjectWorktrees(
  settings: ProjectsSettings,
  input: { machineId: string; platform: "posix" | "windows"; cwd: string },
  observeRoot: ObserveProjectWorktreeRoot,
  observeGit: ObserveProjectGitWorktree,
  requireNamespace: boolean,
): Promise<readonly string[]> {
  const matches = new Set<string>();
  for (const project of settings.projects)
    for (const root of project.worktreeRoots) {
      if (
        root.machineId !== input.machineId ||
        root.platform !== input.platform ||
        (requireNamespace && !projectPathContains(root.path, input.cwd, root.platform, true)) ||
        !project.workspaces.some(
          (workspace) =>
            workspace.machineId === root.machineId &&
            workspace.platform === root.platform &&
            workspace.path === root.repoPath,
        )
      )
        continue;
      try {
        const enrolled = await observeRoot(root);
        if (
          !enrolled ||
          !validateProjectWorktreeRoot(root, enrolled) ||
          enrolled.commonDirectory !== root.commonDirectory
        )
          continue;
        const git = await observeGit(root, input.cwd);
        if (
          !git ||
          !(requireNamespace
            ? matchesProjectWorktree(root, input.cwd, git)
            : matchesRepositoryWorktree(root, input.cwd, git))
        )
          continue;
        if (
          !isDeepStrictEqual(await observeRoot(root), enrolled) ||
          !isDeepStrictEqual(await observeGit(root, input.cwd), git)
        )
          continue;
        matches.add(project.id);
      } catch {
        /* Missing, inaccessible or changed roots grant nothing. */
      }
    }
  return [...matches];
}
