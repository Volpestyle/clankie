import type { RemoteCodexSeats } from "./remote-codex-seats.ts";
import type { ProjectGitWorktreeObservation, ProjectWorktreeRootObservation } from "@clankie/settings";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { win32 } from "node:path";
import type { ProjectProcessProof } from "./project-process-proof.ts";
import type { FleetShellRun, HerdrFleet } from "./herdr-fleet.ts";
import { parseHerdrAgentResult } from "./captain/herdr-watch.ts";
import { occupantIdForHerdrSession } from "./captain/herdr-census.ts";
import {
  windowsCanonicalCommand,
  windowsProcessCommand,
  windowsGitWorktreeCommand,
  windowsWorktreeRootCommand,
} from "./windows-process-probe.ts";

interface Process {
  pid: number;
  parent: number;
  startTime: string;
  executable: string | null;
}
interface Observation {
  binding: { socketPath: string; session: string };
  info: { pane_id: string; shell_pid: number; foreground_process_group_id: number };
  agent: unknown;
  processes: Process[];
  nativeProcesses: { pid: number; cwd: string; executable: string }[];
  owners: number[];
  installed: string[];
  privateServer?: {
    pid: number;
    startTime: string;
    executable: string;
    cwd: string;
    port: number;
    listeners: number[];
  } | null;
}
export interface RemoteStream {
  /** Ports are captured by trusted relay accept(), never copied from HTTP data. */
  readonly clientPort: number;
  readonly serverPort: number;
  alive(): boolean;
}
interface Options {
  fleet(id: string): Promise<HerdrFleet | undefined>;
  shell(fleet: HerdrFleet): FleetShellRun;
  privateSeats?: RemoteCodexSeats;
}

/** Preserve Windows FILETIME's 100 ns precision; Date.parse alone truncates it. */
function creationTicks(value: string): bigint | undefined {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{1,7})Z$/u.exec(value);
  if (!match) return undefined;
  const seconds = Date.parse(`${match[1]}.000Z`);
  if (!Number.isFinite(seconds)) return undefined;
  return BigInt(seconds) * 10_000n + BigInt(match[2]!.padEnd(7, "0"));
}

/** Full live ancestry, including creation order. Missing/dead parents and PID reuse deny. */
function ancestry(processes: readonly Process[], pid: number, shell: number): Process[] | undefined {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  if (byPid.size !== processes.length) return undefined;
  const chain: Process[] = [];
  let current = pid;
  while (current !== 0 && current !== 4) {
    const process = byPid.get(current);
    const started = process && creationTicks(process.startTime);
    const childStarted = chain.length > 0 ? creationTicks(chain.at(-1)!.startTime) : undefined;
    if (
      !process ||
      !Number.isSafeInteger(process.pid) ||
      process.pid <= 4 ||
      !Number.isSafeInteger(process.parent) ||
      process.parent < 0 ||
      started === undefined ||
      chain.length >= 64 ||
      chain.some((entry) => entry.pid === current) ||
      (childStarted !== undefined && started > childStarted)
    )
      return undefined;
    chain.push(process);
    if (current === shell) return chain;
    current = process.parent;
  }
  return undefined;
}

function select(observation: Observation, fleet: HerdrFleet, pane: string, stream?: RemoteStream) {
  if (
    observation.binding.session !== fleet.session ||
    !observation.binding.socketPath ||
    observation.info.pane_id !== pane
  )
    return undefined;
  const agent = parseHerdrAgentResult(JSON.stringify({ result: { agent: observation.agent } }));
  if (agent.paneId !== pane || !["claude", "codex"].includes(agent.agent ?? "")) return undefined;
  const shell = observation.processes.find((process) => process.pid === observation.info.shell_pid);
  const foreground = observation.info.foreground_process_group_id;
  if (!shell || shell.pid === foreground) return undefined;
  const candidates = observation.nativeProcesses.flatMap((native) => {
    if (
      !observation.installed.includes(native.executable) ||
      typeof native.cwd !== "string" ||
      !win32.isAbsolute(native.cwd) ||
      win32.normalize(native.cwd) !== native.cwd
    )
      return [];
    const chain = ancestry(observation.processes, native.pid, shell.pid);
    if (
      !chain ||
      !chain.some((process) => process.pid === foreground) ||
      !chain.some((process) => process.pid === shell.pid)
    )
      return [];
    // Native helpers/subagents share the executable; only the outer native process occupies the pane.
    if (
      chain.slice(1).some((process) => observation.nativeProcesses.some((other) => other.pid === process.pid))
    )
      return [];
    return [{ native, chain }];
  });
  if (candidates.length !== 1) return undefined;
  const candidate = candidates[0]!;
  let socketChain: Process[] | undefined;
  if (stream) {
    if (observation.owners.length !== 1 || !stream.alive()) return undefined;
    socketChain = ancestry(observation.processes, observation.owners[0]!, shell.pid);
    if (!socketChain || !socketChain.some((process) => process.pid === candidate.native.pid))
      return undefined;
  }
  const proof: ProjectProcessProof = {
    fleet: fleet.id,
    pane,
    binding: observation.binding,
    nativeOccupantId: agent.session
      ? occupantIdForHerdrSession(agent.session)
      : `process-${createHash("sha256")
          .update(
            JSON.stringify([
              fleet.id,
              observation.binding,
              pane,
              agent.agent,
              agent.terminalId,
              candidate.chain,
            ]),
          )
          .digest("hex")}`,
    ...(agent.session ? {} : { nativeSessionPending: true as const }),
    shell: { pid: shell.pid, startTime: shell.startTime },
    processes: [{ pid: candidate.native.pid, startTime: candidate.chain[0]!.startTime }],
    workspace: { machineId: fleet.id, platform: "windows", canonicalPath: candidate.native.cwd },
  };
  return {
    proof,
    chain: candidate.chain,
    socketChain,
    foreground,
    executable: candidate.native.executable,
    terminalId: agent.terminalId,
  };
}

/** Fresh initial/final observations over the registered fleet's existing SSH transport. */
export function createRemoteProjectObserver(options: Options) {
  return async (
    fleetId: string,
    pane: string,
    stream?: RemoteStream,
  ): Promise<ProjectProcessProof | undefined> => {
    if (!/^w[\w]+:p[\w]+$/u.test(pane) || fleetId === "default" || (stream && !stream.alive()))
      return undefined;
    try {
      const fleet = await options.fleet(fleetId);
      if (!fleet || fleet.id !== fleetId || fleet.ssh.shell !== "powershell") return undefined;
      const privateServer = stream ? options.privateSeats?.server(fleet, pane) : undefined;
      const command = windowsProcessCommand({
        session: fleet.session,
        pane,
        ...(privateServer ? { privateServer } : {}),
        ...(stream ? { clientPort: stream.clientPort, serverPort: stream.serverPort } : {}),
      });
      const shell = options.shell(fleet);
      const snapshots = JSON.parse(await shell(command, 10_000)) as { first: Observation; last: Observation };
      const choose = async (snapshot: Observation) => {
        const direct = select(snapshot, fleet, pane, stream);
        if (direct || !stream || !privateServer || !options.privateSeats) return direct;
        const view = select(snapshot, fleet, pane);
        const server = snapshot.privateServer;
        if (
          !view ||
          !server ||
          !snapshot.installed.includes(server.executable) ||
          view.proof.nativeSessionPending ||
          snapshot.owners.length !== 1 ||
          server.listeners.length !== 1 ||
          server.listeners[0] !== server.pid ||
          server.cwd !== view.proof.workspace?.canonicalPath
        )
          return undefined;
        const socketChain = ancestry(snapshot.processes, snapshot.owners[0]!, server.pid);
        const lifetime = {
          pid: server.pid,
          startTime: server.startTime,
          executable: server.executable,
          port: server.port,
        };
        if (
          !socketChain ||
          socketChain[0] === undefined ||
          !isDeepStrictEqual(lifetime, privateServer) ||
          !(await options.privateSeats.allows(fleet, view.proof, lifetime))
        )
          return undefined;
        return {
          ...view,
          proof: { ...view.proof, privateSeat: true as const },
          socketChain,
          privateServer: server,
        };
      };
      const first = await choose(snapshots.first);
      if (!first || (stream && !stream.alive())) return undefined;
      const last = await choose(snapshots.last);
      if (
        !isDeepStrictEqual(first, last) ||
        !isDeepStrictEqual(await options.fleet(fleetId), fleet) ||
        (stream && !stream.alive()) ||
        (first.proof.privateSeat &&
          !isDeepStrictEqual(options.privateSeats?.server(fleet, pane), privateServer))
      )
        return undefined;
      return first.proof;
    } catch {
      return undefined;
    }
  };
}

export function createRemoteWorkspaceCanonical(options: Options) {
  return async (machineId: string, path: string): Promise<string | undefined> => {
    try {
      const fleet = await options.fleet(machineId);
      if (
        !fleet ||
        fleet.id !== machineId ||
        fleet.ssh.shell !== "powershell" ||
        !win32.isAbsolute(path) ||
        path.includes("\0")
      )
        return undefined;
      const result: unknown = JSON.parse(await options.shell(fleet)(windowsCanonicalCommand(path), 5_000));
      return typeof result === "string" && isDeepStrictEqual(await options.fleet(machineId), fleet)
        ? result
        : undefined;
    } catch {
      return undefined;
    }
  };
}

/** These Git facts are evidence, not authority: project policy still compares the enrolled root. */
export function createRemoteGitWorktreeObserver(options: Options) {
  return async (
    root: { machineId: string; repoPath: string },
    cwd: string,
  ): Promise<ProjectGitWorktreeObservation | undefined> => {
    try {
      const fleet = await options.fleet(root.machineId);
      if (
        !fleet ||
        fleet.id !== root.machineId ||
        fleet.ssh.shell !== "powershell" ||
        !win32.isAbsolute(cwd) ||
        !win32.isAbsolute(root.repoPath)
      )
        return undefined;
      const result = JSON.parse(
        await options.shell(fleet)(windowsGitWorktreeCommand(root.repoPath, cwd), 5_000),
      );
      return result && isDeepStrictEqual(await options.fleet(root.machineId), fleet) ? result : undefined;
    } catch {
      return undefined;
    }
  };
}

export function createRemoteWorktreeRootObserver(options: Options) {
  return async (input: {
    machineId: string;
    platform: string;
    path: string;
    repoPath: string;
  }): Promise<ProjectWorktreeRootObservation | undefined> => {
    try {
      const fleet = await options.fleet(input.machineId);
      if (
        !fleet ||
        fleet.id !== input.machineId ||
        input.platform !== "windows" ||
        fleet.ssh.shell !== "powershell" ||
        !win32.isAbsolute(input.path) ||
        !win32.isAbsolute(input.repoPath)
      )
        return undefined;
      const result = JSON.parse(
        await options.shell(fleet)(windowsWorktreeRootCommand(input.path, input.repoPath), 5_000),
      );
      return result && isDeepStrictEqual(await options.fleet(input.machineId), fleet) ? result : undefined;
    } catch {
      return undefined;
    }
  };
}
