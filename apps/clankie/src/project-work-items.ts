import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import type { Project, ProjectsSettings } from "@clankie/protocol/projects";
import type { WorkRepo } from "@clankie/protocol/work-items";
import { readConvention } from "@clankie/work-items";

export const projectWorkRepoId = (projectId: string): string =>
  `project-${createHash("sha256").update(projectId).digest("hex").slice(0, 48)}`;

/** Virtual reads do not enroll a repo, discover a convention, or choose an account. */
export function createProjectWorkReader(options: {
  projects: () => Promise<ProjectsSettings>;
  localMachineId: string;
}) {
  const bound = async () =>
    (await options.projects()).projects.filter((project) => project.trackerRef !== undefined);
  const prepare = async (project: Project) => {
    const workspace = project.workspaces.find((entry) => entry.id === project.trackerRef?.workspaceId);
    if (
      !workspace ||
      workspace.machineId !== options.localMachineId ||
      workspace.platform !== (process.platform === "win32" ? "windows" : "posix")
    )
      throw new Error("This project’s work is on another machine and can’t be read here.");
    const path = workspace.path;
    if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0"))
      throw new Error("This project workspace isn’t available.");
    const observe = async () => {
      if ((await realpath(path)) !== path) throw new Error("Workspace path changed");
      const directory = await stat(path);
      if (!directory.isDirectory()) throw new Error("Workspace unavailable");
      const file = join(path, ".clankie", "tracking.json");
      if ((await realpath(file)) !== file) throw new Error("Tracker path changed");
      const convention = await readConvention(path);
      if (!convention) throw new Error("Tracker unavailable");
      return { directory: [directory.dev, directory.ino], convention };
    };
    const initial = await observe().catch(() => {
      throw new Error("This project workspace or its saved work tracker isn’t available.");
    });
    const validate = async () => {
      const current = (await options.projects()).projects.find((entry) => entry.id === project.id);
      if (
        JSON.stringify(current) !== JSON.stringify(project) ||
        JSON.stringify(await observe()) !== JSON.stringify(initial)
      )
        throw new Error("Project work settings changed. Read the work again.");
    };
    await validate();
    return { path, convention: initial.convention, validate };
  };
  return {
    async repos(): Promise<WorkRepo[]> {
      return Promise.all(
        (await bound()).map(async (project) => {
          const base = {
            id: projectWorkRepoId(project.id),
            projectId: project.id,
            name: project.name,
            ...(project.trackerProjectId === undefined ? {} : { trackerProjectId: project.trackerProjectId }),
            needsDecision: false,
          };
          try {
            const read = await prepare(project);
            return { ...base, root: read.path, backend: read.convention.backend };
          } catch {
            // Fixed wording: filesystem and adapter errors may contain local details.
            return {
              ...base,
              unavailable: "This project’s workspace or saved work tracker can’t be read here.",
            };
          }
        }),
      );
    },
    async prepare(ref: string) {
      const project = (await bound()).find((entry) => projectWorkRepoId(entry.id) === ref);
      if (!project) throw new Error("Project work settings changed. Read the work again.");
      const read = await prepare(project);
      return {
        ...read,
        repo: {
          id: ref,
          projectId: project.id,
          name: project.name,
          ...(project.trackerProjectId === undefined ? {} : { trackerProjectId: project.trackerProjectId }),
          root: read.path,
          backend: read.convention.backend,
          needsDecision: false,
        } satisfies WorkRepo,
      };
    },
  };
}
