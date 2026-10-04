import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import {
  CreateProjectSettingsSchema,
  ProjectSchema,
  ProjectsSettingsSchema,
  type CreateProjectSettings,
  type ProjectsSettings,
  type ProjectWorkspace,
} from "@clankie/protocol/projects";
import { WorkConventionSchema } from "@clankie/protocol/work-items";
import { projectsRevision } from "./projects.ts";

/** Pure spelling/namespace rules shared with the owner-authored remote CLI. */
export function assertProjectWorkspacePath(workspace: Pick<ProjectWorkspace, "path" | "platform">): void {
  const paths = workspace.platform === "windows" ? win32 : posix;
  if (
    !paths.isAbsolute(workspace.path) ||
    paths.normalize(workspace.path) !== workspace.path ||
    workspace.path.includes("\0")
  )
    throw new Error("Use the directory's absolute canonical path with its exact spelling");
}

export function assertProjectWorkspaceAvailable(
  settings: ProjectsSettings,
  candidate: ProjectWorkspace,
): void {
  const paths = candidate.platform === "windows" ? win32 : posix;
  const contains = (parent: string, child: string) => {
    const part = paths.relative(parent, child);
    return part === "" || (!paths.isAbsolute(part) && part !== ".." && !part.startsWith(`..${paths.sep}`));
  };
  for (const project of settings.projects)
    for (const workspace of [...project.workspaces, ...project.worktreeRoots])
      if (
        workspace.machineId === candidate.machineId &&
        workspace.platform === candidate.platform &&
        (contains(workspace.path, candidate.path) || contains(candidate.path, workspace.path))
      )
        throw new Error(`This workspace overlaps project ${project.id}; approve a separate directory`);
}

const platform = () => (process.platform === "win32" ? ("windows" as const) : ("posix" as const));
const workspaceFor = (path: string): ProjectWorkspace => ({
  id: "primary",
  machineId: "local",
  platform: platform(),
  path,
});
const identity = (value: { dev: bigint; ino: bigint; birthtimeNs: bigint }) =>
  [value.dev, value.ino, value.birthtimeNs].map(String);

async function directory(path: string) {
  assertProjectWorkspacePath({ path, platform: platform() });
  if ((await realpath(path)) !== path) throw new Error("Project workspace has an alias");
  const value = await lstat(path, { bigint: true });
  if (!value.isDirectory() || value.isSymbolicLink()) throw new Error("Project workspace is not a directory");
  return { path, identity: identity(value) };
}

export class ProjectTrackerUnavailable extends Error {
  constructor() {
    super("The existing .clankie/tracking.json must be a canonical, valid saved tracker before binding it");
    this.name = "ProjectTrackerUnavailable";
  }
}

/** Reads an existing convention only, never discovering or initializing a backend. */
async function tracker(workspace: string) {
  const path = join(workspace, ".clankie", "tracking.json");
  try {
    if ((await realpath(path)) !== path) throw new Error("alias");
    const initial = await lstat(path, { bigint: true });
    if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1n || initial.size > 16_384n)
      throw new Error("unsupported file");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        JSON.stringify(identity(before)) !== JSON.stringify(identity(initial)) ||
        before.size !== initial.size
      )
        throw new Error("replaced file");
      const bytes = Buffer.alloc(16_385);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (
        length > 16_384 ||
        BigInt(length) !== before.size ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs
      )
        throw new Error("changed file");
      WorkConventionSchema.parse(JSON.parse(bytes.toString("utf8", 0, length)));
      const final = await lstat(path, { bigint: true });
      if (
        (await realpath(path)) !== path ||
        JSON.stringify(identity(final)) !== JSON.stringify(identity(before)) ||
        final.size !== after.size ||
        final.mtimeNs !== after.mtimeNs ||
        final.ctimeNs !== after.ctimeNs
      )
        throw new Error("replaced path");
      return {
        path,
        identity: identity(before),
        sha256: createHash("sha256").update(bytes.subarray(0, length)).digest("hex"),
      };
    } finally {
      await handle.close();
    }
  } catch {
    throw new ProjectTrackerUnavailable();
  }
}

/** Host observation for new LOCAL enrollment. These facts never prove caller membership. */
export async function observeProjectEnrollment(settings: ProjectsSettings, command: CreateProjectSettings) {
  const input = CreateProjectSettingsSchema.parse(command);
  assertProjectWorkspaceAvailable(settings, workspaceFor(input.workspacePath));
  const paths = [
    ...new Set([
      input.workspacePath,
      ...settings.projects.flatMap((project) =>
        [...project.workspaces, ...project.worktreeRoots]
          .filter((entry) => entry.machineId === "local" && entry.platform === platform())
          .map((entry) => entry.path),
      ),
    ]),
  ].sort();
  return {
    directories: await Promise.all(paths.map(directory)),
    ...(input.trackerRef ? { tracker: await tracker(input.workspacePath) } : {}),
  };
}

/** Append only a NEW project; observations and owner authority are enforced by the caller. */
export function createProjectSettings(
  settings: ProjectsSettings,
  command: CreateProjectSettings,
): ProjectsSettings {
  const input = CreateProjectSettingsSchema.parse(command);
  if (projectsRevision(settings) !== input.expectedRevision) throw new Error("Project settings changed");
  if (settings.projects.some((project) => project.id === input.projectId))
    throw new Error("Project already exists");
  const workspace = workspaceFor(input.workspacePath);
  assertProjectWorkspacePath(workspace);
  assertProjectWorkspaceAvailable(settings, workspace);
  const roles = input.roles?.map(({ concurrencyCap, ...role }) => ({
    ...role,
    ...(concurrencyCap == null ? {} : { concurrencyCap }),
  }));
  const project = ProjectSchema.parse({
    id: input.projectId,
    name: input.name,
    workspaces: [workspace],
    ...(roles === undefined ? {} : { roles }),
    ...(input.workerCap == null ? {} : { workerCap: input.workerCap }),
    ...(input.trackerRef == null ? {} : { trackerRef: input.trackerRef }),
    ...(input.fleet == null ? {} : { fleet: input.fleet }),
  });
  return ProjectsSettingsSchema.parse({ ...settings, projects: [...settings.projects, project] });
}
