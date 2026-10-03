import { isDeepStrictEqual } from "node:util";
import { win32 } from "node:path";
import type { ProjectProcessProof } from "./project-process-proof.ts";
import type { FleetShellRun, HerdrFleet } from "./herdr-fleet.ts";
import { parseHerdrAgentResult } from "./captain/herdr-watch.ts";
import { occupantIdForHerdrSession } from "./captain/herdr-census.ts";
import { windowsCanonicalCommand, windowsProcessCommand } from "./windows-process-probe.ts";

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
}

/** Full live ancestry, including creation order. Missing/dead parents and PID reuse deny. */
function ancestry(processes: readonly Process[], pid: number, shell: number): Process[] | undefined {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  if (byPid.size !== processes.length) return undefined;
  const chain: Process[] = [];
  let current = pid;
  while (current !== 0 && current !== 4) {
    const process = byPid.get(current);
    if (
      !process ||
      !Number.isSafeInteger(process.pid) ||
      process.pid <= 4 ||
      !Number.isSafeInteger(process.parent) ||
      process.parent < 0 ||
      !Number.isFinite(Date.parse(process.startTime)) ||
      chain.length >= 64 ||
      chain.some((entry) => entry.pid === current) ||
      (chain.length > 0 && Date.parse(process.startTime) > Date.parse(chain.at(-1)!.startTime))
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
  if (agent.paneId !== pane || !agent.session || !["claude", "codex"].includes(agent.agent ?? ""))
    return undefined;
  const shell = observation.processes.find((process) => process.pid === observation.info.shell_pid);
  const foreground = observation.info.foreground_process_group_id;
  if (!shell || shell.pid === foreground) return undefined;
  const candidates = observation.nativeProcesses.flatMap((native) => {
    if (
      !observation.installed.includes(native.executable) ||
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
    nativeOccupantId: occupantIdForHerdrSession(agent.session),
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
      const command = windowsProcessCommand({
        session: fleet.session,
        pane,
        ...(stream ? { clientPort: stream.clientPort, serverPort: stream.serverPort } : {}),
      });
      const shell = options.shell(fleet);
      const first = select(JSON.parse(await shell(command, 8_000)), fleet, pane, stream);
      if (!first || (stream && !stream.alive())) return undefined;
      const last = select(JSON.parse(await shell(command, 8_000)), fleet, pane, stream);
      if (
        !isDeepStrictEqual(first, last) ||
        !isDeepStrictEqual(await options.fleet(fleetId), fleet) ||
        (stream && !stream.alive())
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
