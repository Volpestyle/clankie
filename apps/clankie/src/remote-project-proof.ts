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
interface SeatMarkers {
  pane: string;
  socketPath: string;
  homeHash: string;
}
interface NativeProcess {
  pid: number;
  cwd: string;
  executable: string;
  /** Bounded kernel argv projection, absent only on legacy observations. */
  role?: "tui" | "server" | "other" | "unavailable";
  endpoint?: string | null;
  markers?: SeatMarkers | null;
  listeners?: { pid: number; address: string; port: number }[];
  listenerOwners?: number[];
}
interface Observation {
  binding: { socketPath: string; session: string };
  info: { pane_id: string; shell_pid: number; foreground_process_group_id: number };
  agent: unknown;
  processes: Process[];
  nativeProcesses: NativeProcess[];
  owners: number[];
  installed: string[];
  foregroundMarkers?: SeatMarkers | null;
  privateServer?: {
    pid: number;
    startTime: string;
    executable: string;
    cwd: string;
    port: number;
    listeners: number[];
  } | null;
}
/** Host-observed identity. Never accepts an endpoint, PID or home from a request. */
export interface RemoteCodexControlProof {
  readonly fleet: string;
  readonly pane: string;
  readonly terminalId: string;
  readonly sessionId: string;
  readonly nativeOccupantId: string;
  readonly binding: { readonly socketPath: string; readonly session: string };
  readonly endpoint: string;
  /** A zero argv port is resolved solely from the backend's single kernel listener. */
  readonly listenEndpoint: string;
  readonly homeHash: string;
  /** Canonical current directory shared by the visible TUI and its private backend. */
  readonly cwd: string;
  readonly shell: { readonly pid: number; readonly startTime: string };
  readonly foreground: { readonly pid: number; readonly startTime: string };
  readonly tui: { readonly pid: number; readonly startTime: string; readonly executable: string };
  readonly server: { readonly pid: number; readonly startTime: string; readonly executable: string };
  readonly chains: { readonly tui: readonly Process[]; readonly server: readonly Process[] };
}
/** Actual socket endpoints captured by the native RPC helper, never model/request arguments. */
export interface RemoteCodexControlConnection {
  readonly clientPort: number;
  readonly serverPort: number;
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
      (native.role !== undefined && native.role !== "tui") ||
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

function loopbackPort(endpoint: unknown, allowZero = false): number | undefined {
  if (typeof endpoint !== "string" || !/^ws:\/\/127\.0\.0\.1:(0|[1-9]\d{0,4})$/u.test(endpoint))
    return undefined;
  const port = Number(endpoint.slice(15));
  return port <= 65535 && (allowZero || port > 0) ? port : undefined;
}

/** Both native processes must descend from this exact live foreground wrapper above the shell. */
function selectCodexControl(
  observation: Observation,
  fleet: HerdrFleet,
  pane: string,
  sessionId: string,
  connection?: RemoteCodexControlConnection,
): RemoteCodexControlProof | undefined {
  const view = select(observation, fleet, pane);
  const agent = parseHerdrAgentResult(JSON.stringify({ result: { agent: observation.agent } }));
  if (
    !view ||
    agent.agent !== "codex" ||
    agent.session?.kind !== "id" ||
    agent.session.value !== sessionId ||
    !sessionId ||
    view.proof.nativeSessionPending
  )
    return undefined;
  const tuis = observation.nativeProcesses.filter((native) => native.role === "tui");
  const servers = observation.nativeProcesses.filter((native) => native.role === "server");
  // Unknown argv could conceal another native TUI or daemon; unavailable facts never authorize.
  if (
    tuis.length !== 1 ||
    servers.length !== 1 ||
    observation.nativeProcesses.some((native) => native.role === undefined || native.role === "unavailable")
  )
    return undefined;
  const tui = tuis[0]!;
  const server = servers[0]!;
  const port = loopbackPort(tui.endpoint);
  const listenPort = loopbackPort(server.endpoint, true);
  const shell = view.proof.shell;
  const tuiChain = ancestry(observation.processes, tui.pid, shell.pid);
  const serverChain = ancestry(observation.processes, server.pid, shell.pid);
  const foreground = observation.processes.find((process) => process.pid === view.foreground);
  if (
    port === undefined ||
    listenPort === undefined ||
    (listenPort !== 0 && listenPort !== port) ||
    !tuiChain ||
    !serverChain ||
    !foreground ||
    foreground.pid === shell.pid ||
    !tuiChain.slice(1).some((process) => process.pid === foreground.pid) ||
    !serverChain.slice(1).some((process) => process.pid === foreground.pid) ||
    serverChain.slice(1).some((process) => process.pid === tui.pid) ||
    tui.pid !== view.proof.processes[0]?.pid ||
    server.pid === tui.pid ||
    !observation.installed.includes(server.executable) ||
    server.executable !== tui.executable ||
    serverChain[0]?.executable !== server.executable ||
    tuiChain[0]?.executable !== tui.executable ||
    creationTicks(serverChain[0]!.startTime)! > creationTicks(tuiChain[0]!.startTime)! ||
    [...tuiChain, ...serverChain].some(
      (process) => !process.executable || !win32.isAbsolute(process.executable),
    ) ||
    server.cwd !== tui.cwd ||
    server.listeners?.length !== 1 ||
    server.listeners[0]?.pid !== server.pid ||
    server.listeners[0]?.address !== "127.0.0.1" ||
    server.listeners[0]?.port !== port ||
    server.listenerOwners?.length !== 1 ||
    server.listenerOwners[0] !== server.pid
  )
    return undefined;
  const markers = observation.foregroundMarkers;
  if (
    !markers ||
    markers.pane !== pane ||
    markers.socketPath !== observation.binding.socketPath ||
    !/^[a-f0-9]{64}$/u.test(markers.homeHash) ||
    !isDeepStrictEqual(markers, tui.markers) ||
    !isDeepStrictEqual(markers, server.markers)
  )
    return undefined;
  if (
    connection &&
    (!Number.isSafeInteger(connection.clientPort) ||
      connection.clientPort < 1 ||
      connection.clientPort > 65535 ||
      connection.serverPort !== port ||
      observation.owners.length !== 1 ||
      observation.owners[0] !== server.pid)
  )
    return undefined;
  return {
    fleet: fleet.id,
    pane,
    terminalId: agent.terminalId,
    sessionId,
    nativeOccupantId: view.proof.nativeOccupantId,
    binding: observation.binding,
    endpoint: tui.endpoint!,
    listenEndpoint: server.endpoint!,
    homeHash: markers.homeHash,
    cwd: tui.cwd,
    shell,
    foreground: { pid: foreground.pid, startTime: foreground.startTime },
    tui: { pid: tui.pid, startTime: tuiChain[0]!.startTime, executable: tui.executable },
    server: { pid: server.pid, startTime: serverChain[0]!.startTime, executable: server.executable },
    chains: { tui: tuiChain, server: serverChain },
  };
}

/** Fresh discovery and an optional exact established TCP server-half proof through the same reader. */
export function createRemoteCodexControlObserver(options: Pick<Options, "fleet" | "shell">) {
  return async (
    fleetId: string,
    pane: string,
    sessionId: string,
    connection?: RemoteCodexControlConnection,
  ): Promise<RemoteCodexControlProof | undefined> => {
    if (
      !/^w[\w]+:p[\w]+$/u.test(pane) ||
      fleetId === "default" ||
      (connection &&
        [connection.clientPort, connection.serverPort].some(
          (port) => !Number.isSafeInteger(port) || port < 1 || port > 65535,
        ))
    )
      return undefined;
    try {
      const fleet = await options.fleet(fleetId);
      if (!fleet || fleet.id !== fleetId || fleet.ssh.shell !== "powershell") return undefined;
      const snapshots = JSON.parse(
        await options.shell(fleet)(
          windowsProcessCommand({
            session: fleet.session,
            pane,
            codexControl: true,
            // Reverse the helper's tuple: the listener's accepted socket owns the server half.
            ...(connection ? { clientPort: connection.serverPort, serverPort: connection.clientPort } : {}),
          }),
          10_000,
        ),
      ) as { first: Observation; last: Observation };
      const first = selectCodexControl(snapshots.first, fleet, pane, sessionId, connection);
      const last = selectCodexControl(snapshots.last, fleet, pane, sessionId, connection);
      return first && isDeepStrictEqual(first, last) && isDeepStrictEqual(await options.fleet(fleetId), fleet)
        ? first
        : undefined;
    } catch {
      return undefined;
    }
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
        codexControl: true,
        ...(privateServer ? { privateServer } : {}),
        ...(stream ? { clientPort: stream.clientPort, serverPort: stream.serverPort } : {}),
      });
      const shell = options.shell(fleet);
      const snapshots = JSON.parse(await shell(command, 10_000)) as { first: Observation; last: Observation };
      const choose = async (snapshot: Observation) => {
        const direct = select(snapshot, fleet, pane, stream);
        if (direct || !stream) return direct;
        // A hand-started dedicated backend is a sibling of the visible TUI. Its
        // MCP children inherit that exact current pane only after the same kernel
        // listener/argv/marker/lifetime proof used by native steering succeeds.
        const native = parseHerdrAgentResult(JSON.stringify({ result: { agent: snapshot.agent } }));
        const control =
          native.session?.kind === "id"
            ? selectCodexControl(snapshot, fleet, pane, native.session.value)
            : undefined;
        if (control && snapshot.owners.length === 1 && stream.alive()) {
          const socketChain = ancestry(snapshot.processes, snapshot.owners[0]!, control.server.pid);
          const view = select(snapshot, fleet, pane);
          if (socketChain && view) return { ...view, socketChain, control };
        }
        if (!privateServer || !options.privateSeats) return undefined;
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
