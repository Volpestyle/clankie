import { execFile } from "node:child_process";
import type { HerdrBinding } from "@clankie/protocol";
import { parseHerdrAgentList } from "./captain/herdr-census.ts";
import { createProjectProcessObserver } from "./project-process-proof.ts";
import { nativeRequest } from "./herdr-native-request.ts";
import { createProjectWorkspaceResolver } from "./project-membership.ts";
import type { ProjectsSettings } from "@clankie/protocol/projects";
import type { ProjectProcessProof } from "./project-process-proof.ts";
import { mkdir } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { remoteHerdrCommand, sshArgs, type HerdrFleet } from "./herdr-fleet.ts";
import {
  createRemoteProjectObserver,
  createRemoteWorkspaceCanonical,
  createRemoteGitWorktreeObserver,
  createRemoteWorktreeRootObserver,
} from "./remote-project-proof.ts";

/** Only this read's subprocesses are canceled. Existing tool-proof runners are unchanged. */
export async function membershipNativeCommand(
  file: string,
  args: readonly string[],
  signal: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  signal.throwIfAborted();
  const stdout = await new Promise<string>((resolve, reject) => {
    let error: Error | null = null;
    let output = "";
    const child = execFile(
      file,
      [...args],
      { signal, env, timeout: 5000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, encoding: "utf8" },
      (failure, text) => {
        error = failure;
        output = text;
      },
    );
    // execFile's abort/error callback can precede close. Never release a permit then.
    child.once("close", () => (error ? reject(error) : resolve(output)));
  });
  signal.throwIfAborted();
  return stdout;
}

/** Existing Windows native observer, scoped to this read's SSH children and registered fleet. */
export function remoteFleetMembershipNative(
  fleet: HerdrFleet,
  current: () => Promise<HerdrFleet | undefined>,
  settings: () => Promise<ProjectsSettings>,
  controlDirectory: string,
) {
  const remote = (signal: AbortSignal) => {
    const options = {
      fleet: async (id: string) =>
        id === fleet.id && isDeepStrictEqual(await current(), fleet) ? fleet : undefined,
      shell: (_fleet: HerdrFleet) => async (command: string) => {
        signal.throwIfAborted();
        if (!isDeepStrictEqual(await current(), fleet)) throw new Error("Fleet changed");
        await mkdir(controlDirectory, { recursive: true, mode: 0o700 });
        return membershipNativeCommand("ssh", sshArgs(fleet, controlDirectory, command), signal);
      },
    };
    return options;
  };
  return {
    fleet: fleet.id,
    async binding(signal = new AbortController().signal): Promise<HerdrBinding | undefined> {
      if (!isDeepStrictEqual(await current(), fleet)) return undefined;
      const text = await remote(signal).shell(fleet)(
        remoteHerdrCommand(fleet, ["session", "list", "--json"]),
      );
      const value = JSON.parse(text) as {
        sessions?: { name?: string; running?: boolean; socket_path?: string }[];
      };
      const rows = value.sessions?.filter(
        (row) => row.name === fleet.session && row.running === true && typeof row.socket_path === "string",
      );
      if (rows?.length !== 1 || !isDeepStrictEqual(await current(), fleet)) return undefined;
      return { runtime: "external", socketPath: rows[0]!.socket_path!, session: fleet.session };
    },
    async roster(_binding: HerdrBinding, signal: AbortSignal) {
      const text = await remote(signal).shell(fleet)(remoteHerdrCommand(fleet, ["agent", "list"]));
      return parseHerdrAgentList(text).map((agent) => ({
        ...agent,
        ...(agent.terminalId ? { terminalId: `${fleet.id}/${agent.terminalId}` } : {}),
      }));
    },
    async observe(pane: string, _binding: HerdrBinding, signal: AbortSignal) {
      return createRemoteProjectObserver(remote(signal))(fleet.id, pane);
    },
    async workspace(proof: ProjectProcessProof, signal: AbortSignal) {
      const options = remote(signal);
      return createProjectWorkspaceResolver({
        settings,
        observe: createRemoteProjectObserver(options),
        remoteCanonical: createRemoteWorkspaceCanonical(options),
        worktreeRoot: createRemoteWorktreeRootObserver(options),
        gitWorktree: createRemoteGitWorktreeObserver(options),
      })(proof);
    },
  };
}
export function fleetMembershipNative(
  binding: () => Promise<HerdrBinding | undefined>,
  settings?: () => Promise<ProjectsSettings>,
) {
  const native = {
    async roster(current: HerdrBinding, signal: AbortSignal) {
      return parseHerdrAgentList(
        JSON.stringify(await nativeRequest(current, "agent.list", {}, { signal, timeoutMs: 5_000 })),
      );
    },
    async observe(pane: string, expected: HerdrBinding, signal: AbortSignal) {
      const observe = createProjectProcessObserver({
        herdrBinary: "herdr",
        binding: async () => {
          signal.throwIfAborted();
          const current = await binding();
          signal.throwIfAborted();
          return JSON.stringify(current) === JSON.stringify(expected) ? current : undefined;
        },
        signal,
      });
      return observe("default", pane);
    },
  };
  return {
    ...native,
    ...(settings
      ? {
          workspace: async (proof: ProjectProcessProof, signal: AbortSignal) => {
            const current = await binding();
            if (!current) return undefined;
            const resolve = createProjectWorkspaceResolver({
              settings,
              observe: (_fleet, pane) => native.observe(pane, current, signal),
              cwd: async (pid) => {
                const output = await membershipNativeCommand(
                  "/usr/sbin/lsof",
                  ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
                  signal,
                );
                const paths = output
                  .split("\n")
                  .filter((line) => line.startsWith("n"))
                  .map((line) => line.slice(1));
                return paths.length === 1 ? paths[0] : undefined;
              },
            });
            return resolve(proof);
          },
        }
      : {}),
  };
}
