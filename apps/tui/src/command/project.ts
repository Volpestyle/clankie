import { realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize, relative, sep } from "node:path";
import { inspectOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { SettingsStore, defaultSettingsPath } from "@clankie/settings";
import { ProjectSchema } from "@clankie/protocol/projects";

const USAGE = "Usage: clankie project add NAME --workspace /absolute/canonical/path";
const contains = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
};

/** Explicit local owner configuration only. Creates no role assignment, hire, or tool grant. */
export async function runProjectCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    settings?: SettingsStore;
    operatorCredentialStore?: CredentialStore;
  } = {},
) {
  if (args.length !== 4 || args[0] !== "add" || args[2] !== "--workspace") throw new Error(USAGE);
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
  if (
    !isAbsolute(path) ||
    normalize(path) !== path ||
    (await realpath(path)) !== path ||
    !(await stat(path)).isDirectory()
  )
    throw new Error("Use the directory's absolute canonical path with its exact spelling");
  const project = ProjectSchema.parse({
    id: args[1],
    name: args[1],
    workspaces: [
      {
        id: "primary",
        machineId: "local",
        platform: process.platform === "win32" ? "windows" : "posix",
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
              workspace.machineId === "local" && workspace.platform === project.workspaces[0]!.platform,
          )
          .map((workspace) => workspace.path),
      );
      if (current.projects.projects.some((saved) => saved.id === project.id))
        throw new Error("This project already exists");
      for (const saved of current.projects.projects)
        for (const workspace of saved.workspaces)
          if (
            workspace.machineId === "local" &&
            workspace.platform === project.workspaces[0]!.platform &&
            (contains(workspace.path, path) || contains(path, workspace.path))
          )
            throw new Error(`This workspace overlaps project ${saved.id}; approve a separate directory`);
      return {
        ...current,
        projects: { ...current.projects, projects: [...current.projects.projects, project] },
      };
    },
    async () => {
      for (const existing of [path, ...approved])
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
