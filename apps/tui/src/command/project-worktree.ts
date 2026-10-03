import {
  inspectOperatorCredential,
  resolveOperatorCredential,
  type CredentialStore,
} from "@clankie/credential-broker";
import {
  PROJECTS_PATH,
  PROJECT_ADD_WORKTREE_ROOT_PATH,
  PROJECT_REMOVE_WORKTREE_ROOT_PATH,
  ProjectsSnapshotSchema,
} from "@clankie/protocol/projects";
import { commandHost } from "./io.ts";

/** Owner enrollment uses the service's authoritative machine observer and guarded settings write. */
export async function runProjectWorktreeCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    operatorCredentialStore?: CredentialStore;
  },
) {
  const add = args[0] === "add";
  const base = add ? 6 : 4;
  if (
    (!add && args[0] !== "remove-worktree-root") ||
    args[2] !== "--worktree-root" ||
    (add && args[4] !== "--repo") ||
    ![base, base + 4].includes(args.length) ||
    (args.length > base && (args[base] !== "--machine" || args[base + 2] !== "--platform"))
  )
    throw new Error(
      "Usage: clankie project add NAME --worktree-root ROOT --repo APPROVED_REPO [--machine ID --platform windows|posix]; remove-worktree-root NAME --worktree-root ROOT [--machine ID --platform windows|posix]",
    );
  const machineId = args[base + 1] ?? "local";
  const platform = args[base + 3] ?? (process.platform === "win32" ? "windows" : "posix");
  if (!["windows", "posix"].includes(platform)) throw new Error("Invalid platform");
  const credentialOptions = {
    env: options.env ?? process.env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  };
  const inspection = await inspectOperatorCredential(credentialOptions);
  if (!["consistent", "store_only"].includes(inspection.consistency))
    throw new Error("Worktree root changes require the canonical operator credential");
  const credential = await resolveOperatorCredential(credentialOptions);
  if (!credential) throw new Error("Operator credential unavailable");
  const request = async (path: string, body?: unknown) => {
    const response = await (options.fetchImpl ?? fetch)(new URL(path, commandHost(options)), {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(`Project root operation refused (${response.status}): ${JSON.stringify(result)}`);
    return result;
  };
  const snapshot = ProjectsSnapshotSchema.parse(await request(PROJECTS_PATH));
  if (add)
    return request(PROJECT_ADD_WORKTREE_ROOT_PATH, {
      projectId: args[1],
      machineId,
      platform,
      path: args[3],
      repoPath: args[5],
      expectedRevision: snapshot.revision,
    });
  const root = snapshot.settings.projects
    .find((project) => project.id === args[1])
    ?.worktreeRoots.find(
      (entry) => entry.path === args[3] && entry.machineId === machineId && entry.platform === platform,
    );
  if (!root) throw new Error("Unknown worktree root; use its registered exact path");
  return request(PROJECT_REMOVE_WORKTREE_ROOT_PATH, {
    projectId: args[1],
    rootId: root.id,
    expectedRevision: snapshot.revision,
  });
}
