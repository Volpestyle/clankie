import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify, isDeepStrictEqual } from "node:util";
import {
  resolveProjectMembership,
  projectsRevision,
  projectWorktreeMatches,
  observeLocalProjectWorktreeRoot,
  observeLocalProjectGitWorktree,
  type ObserveProjectWorktreeRoot,
  type ObserveProjectGitWorktree,
} from "@clankie/settings";
import type { ProjectsSettings } from "@clankie/protocol/projects";
import type { LocalFleetIdentity } from "./local-fleet-link.ts";
import type { ProjectProcessProof } from "./project-process-proof.ts";

export type ProjectHireLookup =
  | { state: "none" }
  | { state: "invalid" }
  | { state: "assigned"; projectId: string; role?: string; occupantId: string };
const exec = promisify(execFile);
type WorkspaceOptions = {
  settings(): Promise<ProjectsSettings>;
  canonical?(path: string): Promise<string>;
  cwd?(pid: number): Promise<string | undefined>;
  remoteCanonical?(machineId: string, path: string): Promise<string | undefined>;
  worktreeRoot?: ObserveProjectWorktreeRoot;
  gitWorktree?: ObserveProjectGitWorktree;
};
const processCwd = async (pid: number) => {
  const { stdout } = await exec("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    timeout: 5_000,
    maxBuffer: 100_000,
    encoding: "utf8",
  });
  const paths = stdout
    .split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1));
  return paths.length === 1 ? paths[0] : undefined;
};

/** Called only inside a caller's initial/final native-process proof checks. */
async function workspaceProject(
  options: WorkspaceOptions,
  proof: ProjectProcessProof,
  settings: ProjectsSettings,
): Promise<string | undefined> {
  const remote = proof.fleet !== "default";
  if (remote && (!proof.workspace || proof.workspace.machineId !== proof.fleet || !options.remoteCanonical))
    return undefined;
  const machineId = remote ? proof.workspace!.machineId : "local";
  const platform = remote ? proof.workspace!.platform : "posix";
  const canonical = remote
    ? (path: string) => options.remoteCanonical!(machineId, path)
    : (options.canonical ?? realpath);
  const cwd = remote ? async (_pid: number) => proof.workspace?.canonicalPath : (options.cwd ?? processCwd);
  const current = await cwd(proof.processes[0]!.pid);
  if (!current || (await canonical(current)) !== current) return undefined;
  const eligible: ProjectsSettings = { ...settings, projects: [] };
  for (const project of settings.projects) {
    const workspaces = [];
    for (const workspace of project.workspaces) {
      if (workspace.machineId !== machineId || workspace.platform !== platform) continue;
      try {
        if ((await canonical(workspace.path)) === workspace.path) workspaces.push(workspace);
      } catch {
        // Missing or inaccessible registrations match nobody; unrelated projects remain usable.
      }
    }
    eligible.projects.push({ ...project, workspaces });
  }
  const membership = resolveProjectMembership(eligible, {
    occupantId: JSON.stringify(proof),
    workspace: { machineId, platform, canonicalPath: current },
  });
  if (membership.outcome === "ambiguous") return undefined;
  const matched = new Set(
    await projectWorktreeMatches(
      settings,
      { machineId, platform, cwd: current },
      options.worktreeRoot ?? observeLocalProjectWorktreeRoot,
      options.gitWorktree ?? observeLocalProjectGitWorktree,
    ),
  );
  if (membership.outcome === "member") matched.add(membership.projectId);
  if (matched.size !== 1 || (await cwd(proof.processes[0]!.pid)) !== current) return undefined;
  return [...matched][0];
}

/** Shared actual-cwd policy for hire source selection and worker tool eligibility. */
export function createProjectWorkspaceResolver(
  options: WorkspaceOptions & {
    observe(fleet: string, pane: string): Promise<ProjectProcessProof | undefined>;
  },
) {
  return async (proof: ProjectProcessProof): Promise<string | undefined> => {
    try {
      if (
        proof.privateSeat ||
        (proof.fleet !== "default" && (!proof.workspace || proof.workspace.machineId !== proof.fleet)) ||
        proof.processes.length !== 1 ||
        !isDeepStrictEqual(await options.observe(proof.fleet, proof.pane), proof)
      )
        return undefined;
      const settings = await options.settings();
      const revision = projectsRevision(settings);
      const projectId = await workspaceProject(options, proof, settings);
      if (
        !projectId ||
        !isDeepStrictEqual(await options.observe(proof.fleet, proof.pane), proof) ||
        projectsRevision(await options.settings()) !== revision
      )
        return undefined;
      return projectId;
    } catch {
      return undefined;
    }
  };
}

/** Inputs come from the local listener and host ledger, never bridge headers or settings assignments. */
export function createProjectMembershipResolver(
  options: WorkspaceOptions & {
    hire(proof: ProjectProcessProof): Promise<ProjectHireLookup>;
  },
) {
  return async (
    identity: LocalFleetIdentity,
  ): Promise<{ projectId: string; occupantId: string } | undefined> => {
    try {
      // These independent observations share a checkpoint, not an authority cache.
      const [valid, proof] = await Promise.all([identity.validate(), identity.projectProof?.()]);
      if (
        !valid ||
        !proof ||
        (proof.fleet !== "default" && (!proof.workspace || proof.workspace.machineId !== proof.fleet)) ||
        proof.pane !== identity.pane ||
        proof.processes.length !== 1
      )
        return undefined;
      const settings = await options.settings();
      const revision = projectsRevision(settings);
      const { privateSeat: _privateSeat, ...assignmentProof } = proof;
      const hire = await options.hire(assignmentProof);
      if (
        hire.state === "invalid" ||
        (proof.privateSeat && hire.state !== "assigned") ||
        (proof.nativeSessionPending && hire.state !== "none")
      )
        return undefined;
      // Late SessionStart reporting changes metadata, not an owner-started process's authority.
      const {
        nativeOccupantId: _nativeOccupantId,
        nativeSessionPending: _nativeSessionPending,
        ...processProof
      } = proof;
      const occupantId = JSON.stringify(hire.state === "none" ? processProof : proof);
      let projectId: string | undefined;
      if (hire.state === "assigned") {
        const membership = resolveProjectMembership(settings, {
          occupantId: hire.occupantId,
          hire: {
            projectId: hire.projectId,
            ...(hire.role === undefined ? {} : { role: hire.role }),
            occupantId: hire.occupantId,
          },
        });
        if (membership.outcome === "member") projectId = membership.projectId;
      } else {
        projectId = await workspaceProject(options, proof, settings);
      }
      if (!projectId) return undefined;
      const [stillValid, currentProof] = await Promise.all([identity.validate(), identity.projectProof?.()]);
      if (
        !stillValid ||
        !isDeepStrictEqual(currentProof, proof) ||
        !isDeepStrictEqual(await options.hire(assignmentProof), hire) ||
        projectsRevision(await options.settings()) !== revision
      )
        return undefined;
      return { projectId, occupantId };
    } catch {
      return undefined;
    }
  };
}
