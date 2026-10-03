import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify, isDeepStrictEqual } from "node:util";
import { resolveProjectMembership, projectsRevision } from "@clankie/settings";
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

/** Shared actual-cwd policy for hire source selection and worker tool eligibility. */
export function createProjectWorkspaceResolver(
  options: WorkspaceOptions & {
    observe(fleet: string, pane: string): Promise<ProjectProcessProof | undefined>;
  },
) {
  const canonical = options.canonical ?? realpath;
  const cwd = options.cwd ?? processCwd;
  return async (proof: ProjectProcessProof): Promise<string | undefined> => {
    try {
      if (
        proof.privateSeat ||
        proof.fleet !== "default" ||
        proof.processes.length !== 1 ||
        !isDeepStrictEqual(await options.observe(proof.fleet, proof.pane), proof)
      )
        return undefined;
      const settings = await options.settings();
      const revision = projectsRevision(settings);
      const current = await cwd(proof.processes[0]!.pid);
      if (!current || (await canonical(current)) !== current) return undefined;
      for (const project of settings.projects)
        for (const workspace of project.workspaces)
          if (
            workspace.machineId === "local" &&
            workspace.platform === "posix" &&
            (await canonical(workspace.path)) !== workspace.path
          )
            return undefined;
      const membership = resolveProjectMembership(settings, {
        occupantId: JSON.stringify(proof),
        workspace: { machineId: "local", platform: "posix", canonicalPath: current },
      });
      if (
        membership.outcome !== "member" ||
        (await cwd(proof.processes[0]!.pid)) !== current ||
        !isDeepStrictEqual(await options.observe(proof.fleet, proof.pane), proof) ||
        projectsRevision(await options.settings()) !== revision
      )
        return undefined;
      return membership.projectId;
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
      if (!(await identity.validate())) return undefined;
      const proof = await identity.projectProof?.();
      if (!proof || proof.fleet !== "default" || proof.pane !== identity.pane || proof.processes.length !== 1)
        return undefined;
      const occupantId = JSON.stringify(proof);
      const settings = await options.settings();
      const revision = projectsRevision(settings);
      const { privateSeat: _privateSeat, ...assignmentProof } = proof;
      const hire = await options.hire(assignmentProof);
      if (hire.state === "invalid" || (proof.privateSeat && hire.state !== "assigned")) return undefined;
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
        projectId = await createProjectWorkspaceResolver({
          ...options,
          observe: async () => identity.projectProof?.(),
        })(proof);
      }
      if (
        !projectId ||
        !(await identity.validate()) ||
        !isDeepStrictEqual(await identity.projectProof?.(), proof) ||
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
