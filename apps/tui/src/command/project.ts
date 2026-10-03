import { runProjectWorktreeCommand } from "./project-worktree.ts";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { inspectOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  SettingsStore,
  defaultSettingsPath,
  projectsRevision,
  removeProjectWorkspace,
} from "@clankie/settings";
import { ProjectSchema } from "@clankie/protocol/projects";

const USAGE =
  "Usage: clankie project add|remove-workspace NAME --workspace /absolute/canonical/path [--machine ID --platform windows|posix]";
/** Explicit local owner configuration only. Creates no role assignment, hire, or tool grant. */
export async function runProjectCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    settings?: SettingsStore;
    operatorCredentialStore?: CredentialStore;
    host?: string;
    fetchImpl?: typeof fetch;
  } = {},
) {
  if (args[2] === "--worktree-root" || args[0] === "remove-worktree-root")
    return runProjectWorktreeCommand(args, options);
  if (
    ![4, 8].includes(args.length) ||
    !["add", "remove-workspace"].includes(args[0]!) ||
    args[2] !== "--workspace"
  )
    throw new Error(USAGE);
  const machineId = args.length === 8 && args[4] === "--machine" ? args[5]! : "local";
  const platform =
    args.length === 8 && args[6] === "--platform"
      ? args[7]!
      : process.platform === "win32"
        ? "windows"
        : "posix";
  if (
    args.length === 8 &&
    (args[4] !== "--machine" ||
      args[6] !== "--platform" ||
      machineId === "local" ||
      !machineId.trim() ||
      !["windows", "posix"].includes(platform))
  )
    throw new Error(USAGE);
  const paths = platform === "windows" ? win32 : posix;
  const { isAbsolute, normalize, relative, sep } = paths;
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
  };
  const env = options.env ?? process.env;
  const credential = await inspectOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (!["consistent", "store_only"].includes(credential.consistency))
    throw new Error(
      "Project workspace approval needs the canonical operator credential; the supplied token does not match the broker",
    );
  const path = args[3]!;
  if (args[0] === "remove-workspace") {
    if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0"))
      throw new Error("Use the registered absolute path with its exact spelling");
    const settings = options.settings ?? new SettingsStore(defaultSettingsPath(env));
    let before: string | undefined;
    const result = await settings.update(
      (current) => {
        before = JSON.stringify(current);
        const project = current.projects.projects.find((saved) => saved.id === args[1]);
        const workspace = project?.workspaces.find(
          (saved) => saved.machineId === machineId && saved.platform === platform && saved.path === path,
        );
        if (!project || !workspace)
          throw new Error("Unknown project workspace; use its registered exact path");
        return {
          ...current,
          projects: removeProjectWorkspace(current.projects, {
            projectId: project.id,
            workspaceId: workspace.id,
            expectedRevision: projectsRevision(current.projects),
          }),
        };
      },
      async () => {
        const currentCredential = await inspectOperatorCredential({
          env,
          ...(options.operatorCredentialStore === undefined
            ? {}
            : { store: options.operatorCredentialStore }),
        });
        if (!["consistent", "store_only"].includes(currentCredential.consistency))
          throw new Error("The operator credential changed; run the project command again");
        if (JSON.stringify(await settings.load()) !== before)
          throw new Error("Settings changed; run the project command again");
      },
    );
    return {
      project: result.projects.projects.find((project) => project.id === args[1])!,
      note: "Project workspace removed. Project policy, assignments and grants were preserved.",
    };
  }

  if (
    !isAbsolute(path) ||
    normalize(path) !== path ||
    path.includes("\0") ||
    (machineId === "local" && ((await realpath(path)) !== path || !(await stat(path)).isDirectory()))
  )
    throw new Error("Use the directory's absolute canonical path with its exact spelling");
  let project = ProjectSchema.parse({
    id: args[1],
    name: args[1],
    workspaces: [
      {
        id: "primary",
        machineId,
        platform,
        path,
      },
    ],
  });
  const settings = options.settings ?? new SettingsStore(defaultSettingsPath(env));
  let before: string | undefined;
  let approved: string[] = [];
  await settings.update(
    (current) => {
      before = JSON.stringify(current);
      approved = current.projects.projects.flatMap((saved) =>
        saved.workspaces
          .filter(
            (workspace) =>
              workspace.machineId === machineId && workspace.platform === project.workspaces[0]!.platform,
          )
          .map((workspace) => workspace.path),
      );
      for (const saved of current.projects.projects)
        for (const workspace of [...saved.workspaces, ...saved.worktreeRoots])
          if (
            workspace.machineId === machineId &&
            workspace.platform === project.workspaces[0]!.platform &&
            (contains(workspace.path, path) || contains(path, workspace.path))
          )
            throw new Error(`This workspace overlaps project ${saved.id}; approve a separate directory`);
      const existing = current.projects.projects.find((saved) => saved.id === project.id);
      if (existing) {
        const workspace = project.workspaces[0]!;
        const id = `workspace-${createHash("sha256")
          .update(JSON.stringify([workspace.machineId, workspace.platform, workspace.path]))
          .digest("hex")
          .slice(0, 48)}`;
        project = ProjectSchema.parse({
          ...existing,
          workspaces: [...existing.workspaces, { ...workspace, id }],
        });
      }
      return {
        ...current,
        projects: {
          ...current.projects,
          projects: existing
            ? current.projects.projects.map((saved) => (saved.id === project.id ? project : saved))
            : [...current.projects.projects, project],
        },
      };
    },
    async () => {
      for (const existing of machineId === "local" ? [path, ...approved] : [])
        if ((await realpath(existing)) !== existing || !(await stat(existing)).isDirectory())
          throw new Error("A project workspace changed or has an alias; check its canonical path");
      const currentCredential = await inspectOperatorCredential({
        env,
        ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
      });
      if (!["consistent", "store_only"].includes(currentCredential.consistency))
        throw new Error("The operator credential changed; run the project command again");
      if (JSON.stringify(await settings.load()) !== before)
        throw new Error("Settings changed; run the project command again");
    },
  );
  return {
    project,
    note: "Project workspace saved. No tools were granted; use clankie access project NAME SERVER for an explicit grant.",
  };
}
