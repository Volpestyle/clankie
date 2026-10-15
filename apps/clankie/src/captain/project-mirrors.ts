import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Project, ProjectWorkspace } from "@clankie/protocol/projects";

const run = promisify(execFile);

/** Where a project's default-branch history can be read on this Mac (ADR 0270). */
type ProjectHistorySource =
  | {
      readonly state: "readable";
      readonly source: "workspace" | "mirror";
      readonly repositories: readonly string[];
    }
  | { readonly state: "unknown"; readonly reason: string };

/** Resolves a remote workspace's origin URL over its machine's existing command channel. */
export type RemoteOriginReader = (workspace: ProjectWorkspace) => Promise<string>;

const FETCH_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 10_000;
/** Remote-supplied URLs reach only these transports; `ext::`, `fd::` and local paths never do. */
const PROTOCOLS = ["https", "ssh", "git"] as const;
const PROTOCOL_CONFIG = [
  "-c",
  "protocol.allow=never",
  ...PROTOCOLS.flatMap((name) => ["-c", `protocol.${name}.allow=always`]),
];

function localRepositories(project: Project): string[] {
  return project.workspaces
    .filter((workspace) => workspace.machineId === "local")
    .map((workspace) => workspace.path);
}

/** A project mirrored here: no local workspace, at least one on another machine. */
function remoteWorkspace(project: Project): ProjectWorkspace | undefined {
  return localRepositories(project).length ? undefined : project.workspaces[0];
}

const mirrorName = (projectId: string) =>
  `${createHash("sha256").update(projectId).digest("hex").slice(0, 24)}.git`;
const workspaceKey = (workspace: ProjectWorkspace) => JSON.stringify([workspace.machineId, workspace.path]);

/** Refuses URLs a remote machine could use to reach anything but a network origin, or that carry a secret. */
function mirrorableOrigin(url: string): string | undefined {
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s\\]+$/u.test(url)) return undefined;
  const scheme = /^([a-z]+):\/\//u.exec(url)?.[1];
  if (scheme === undefined || !(PROTOCOLS as readonly string[]).includes(scheme)) {
    return "origin is not an https, ssh or git URL";
  }
  try {
    return new URL(url).password ? "origin URL carries a credential" : undefined;
  } catch {
    return "origin URL is malformed";
  }
}

const failure = (error: unknown) =>
  ((error as { stderr?: string }).stderr?.trim() || (error as Error).message)
    .split("\n")
    .at(-1)!
    .slice(0, 300);

async function git(repository: string, args: readonly string[], timeout = GIT_TIMEOUT_MS) {
  return run("git", ["-C", repository, ...PROTOCOL_CONFIG, ...args], {
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
    },
  });
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * Bare mirrors of remote-only projects' origins under the service's state directory.
 * Each origin is resolved once over the linked machine's command channel and kept in
 * the mirror's own config; nothing is written on the remote machine. `refresh` runs
 * once per Auto round: it fetches every Auto project's mirror and removes mirrors no
 * project names any more. A failed fetch leaves that project's history unknown until
 * the next round's fetch succeeds.
 */
export class ProjectMirrors {
  private readonly failures = new Map<string, string>();
  private readonly root: string;
  private readonly readOrigin: RemoteOriginReader;

  constructor(root: string, readOrigin: RemoteOriginReader) {
    this.root = root;
    this.readOrigin = readOrigin;
  }

  /** The local workspaces, else the mirror as last fetched; never fetches. */
  async history(project: Project): Promise<ProjectHistorySource> {
    const local = localRepositories(project);
    if (local.length) return { state: "readable", source: "workspace", repositories: local };
    if (remoteWorkspace(project) === undefined)
      return { state: "unknown", reason: "project has no workspace" };
    const failed = this.failures.get(project.id);
    if (failed !== undefined) return { state: "unknown", reason: failed };
    const mirror = join(this.root, mirrorName(project.id));
    return (await exists(mirror))
      ? { state: "readable", source: "mirror", repositories: [mirror] }
      : { state: "unknown", reason: "origin not mirrored yet" };
  }

  async refresh(projects: readonly Project[]): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const named = new Set<string>();
    for (const project of projects) {
      const workspace = remoteWorkspace(project);
      if (workspace === undefined) {
        this.failures.delete(project.id);
        continue;
      }
      named.add(mirrorName(project.id));
      if (project.auto !== true) continue;
      const reason = await this.fetch(project.id, workspace).catch((error: unknown) => failure(error));
      if (reason === undefined) this.failures.delete(project.id);
      else this.failures.set(project.id, reason);
    }
    for (const id of this.failures.keys())
      if (!projects.some((project) => project.id === id)) this.failures.delete(id);
    for (const entry of await readdir(this.root)) {
      if (!named.has(entry)) await rm(join(this.root, entry), { recursive: true, force: true });
    }
  }

  /** Undefined when the mirror is current; otherwise why it is not. */
  private async fetch(projectId: string, workspace: ProjectWorkspace): Promise<string | undefined> {
    const mirror = join(this.root, mirrorName(projectId));
    const resolvedFor = await git(mirror, ["config", "--get", "clankie.workspace"]).then(
      ({ stdout }) => stdout.trim(),
      () => undefined,
    );
    if (resolvedFor !== workspaceKey(workspace)) {
      let origin: string;
      try {
        origin = (await this.readOrigin(workspace)).trim();
      } catch (error) {
        return `origin unreadable on ${workspace.machineId}: ${failure(error)}`;
      }
      const refused = mirrorableOrigin(origin);
      if (refused !== undefined) return refused;
      await rm(mirror, { recursive: true, force: true });
      await run("git", ["init", "--quiet", "--bare", mirror], { timeout: GIT_TIMEOUT_MS });
      await git(mirror, ["remote", "add", "origin", origin]);
      await git(mirror, ["config", "clankie.workspace", workspaceKey(workspace)]);
    }
    try {
      await git(mirror, ["fetch", "--quiet", "--prune", "--no-tags", "origin"], FETCH_TIMEOUT_MS);
    } catch (error) {
      return `origin fetch failed: ${failure(error)}`;
    }
    const head = await git(mirror, ["rev-parse", "--verify", "--quiet", "origin/HEAD"]).then(
      () => true,
      () => false,
    );
    if (!head)
      await git(mirror, ["remote", "set-head", "origin", "--auto"], FETCH_TIMEOUT_MS).catch(() => undefined);
    return undefined;
  }
}
