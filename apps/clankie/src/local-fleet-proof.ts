import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Socket } from "node:net";
import { pinHerdrEnvironment } from "./herdr-session.ts";
import type { HerdrBinding } from "@clankie/protocol";
import { createProjectProcessObserver, type ProjectProcessProof } from "./project-process-proof.ts";
import {
  fleetProcessHelper,
  observeSocketProcess,
  type NativeSocketOwner,
  type NativeSocketProcess,
} from "./local-fleet-process.ts";

const exec = promisify(execFile);
type Run = (command: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;
const run: Run = async (command, args, env) =>
  (await exec(command, args, { env, timeout: 5_000, maxBuffer: 2_000_000, encoding: "utf8" })).stdout;

/** Only OS-observed socket owners count; a request PID or forwarded header never does. */
export function clientPid(output: string, clientPort: number, serverPort: number): number | undefined {
  const target = `127.0.0.1:${clientPort}->127.0.0.1:${serverPort}`;
  const owners = new Set<number>();
  let pid: number | undefined;
  for (const line of output.split("\n")) {
    if (/^p\d+$/u.test(line)) pid = Number(line.slice(1));
    if (line === `n${target}` && pid !== undefined) owners.add(pid);
  }
  return owners.size === 1 ? [...owners][0] : undefined;
}

/** Bounded and cycle-safe. Missing parents never create authority. */
export function ancestors(output: string, pid: number): number[] {
  const parents = new Map<number, number>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (match) parents.set(Number(match[1]), Number(match[2]));
  }
  const chain: number[] = [];
  let current = pid;
  for (; current > 1 && chain.length < 64 && !chain.includes(current);) {
    if (!parents.has(current)) return [];
    chain.push(current);
    current = parents.get(current)!;
  }
  return current <= 1 ? chain : [];
}

export interface LocalFleetProofOptions extends Pick<
  Parameters<typeof createProjectProcessObserver>[0],
  "launcher" | "canonical"
> {
  binding(): Promise<HerdrBinding | undefined>;
  /** Server-owned private app-server registry; never supplied by a caller. */
  privateSeat?(ancestors: readonly number[], pane: string, binding: HerdrBinding): Promise<boolean>;
  privateProjectSeat?(
    ancestors: readonly number[],
    pane: string,
    binding: HerdrBinding,
    proof: ProjectProcessProof,
  ): Promise<boolean>;
  herdrBinary: string;
  run?: Run;
  platform?: string;
  processHelper?: string;
  /** Host observation seam; production always uses the fresh native census. */
  observeSocket?(socket: Socket, expected?: NativeSocketOwner): Promise<NativeSocketProcess | undefined>;
  /** Server-owned additional lifetime pin. It can refuse, never grant admission. */
  expectedOwner?(socket: Socket): NativeSocketOwner | undefined;
}

/** macOS local proof. Unsupported platforms and disconnected sockets fail closed. */
export function localFleetProof(options: LocalFleetProofOptions) {
  const execute = options.run ?? run;
  const observe: NonNullable<LocalFleetProofOptions["observeSocket"]> =
    options.observeSocket ??
    ((socket, expected) =>
      observeSocketProcess(socket, options.processHelper ?? fleetProcessHelper(), expected));
  const owners = new WeakMap<Socket, NativeSocketOwner>();
  return async (socket: Socket, pane: string): Promise<boolean> => {
    if ((options.platform ?? process.platform) !== "darwin" || !/^w[\w]+:p[\w]+$/u.test(pane)) return false;
    const clientPort = socket.remotePort;
    const serverPort = socket.localPort;
    const alive = () =>
      !socket.destroyed &&
      socket.readable &&
      socket.writable &&
      socket.remoteAddress === "127.0.0.1" &&
      socket.localAddress === "127.0.0.1" &&
      socket.remotePort === clientPort &&
      socket.localPort === serverPort;
    if (!alive() || !clientPort || !serverPort) return false;
    try {
      const binding = await options.binding();
      if (!binding) return false;
      const initial = await observe(socket, options.expectedOwner?.(socket) ?? owners.get(socket));
      if (!initial || !alive()) return false;
      const chain = initial.ancestors.map((ancestor) => ancestor.pid);
      const paneInfo = async () => {
        const result = JSON.parse(
          await execute(
            options.herdrBinary,
            ["pane", "process-info", "--pane", pane],
            pinHerdrEnvironment({ ...process.env }, binding.socketPath),
          ),
        );
        return result?.result?.process_info;
      };
      const info = await paneInfo();
      if (info?.pane_id !== pane) return false;
      const shell = info.shell_pid;
      if (!Number.isSafeInteger(shell) || shell <= 1) return false;
      const admitted = chain.includes(shell) || (await options.privateSeat?.(chain, pane, binding)) === true;
      if (!admitted) return false;
      const [final, latest] = await Promise.all([observe(socket, initial.owner), paneInfo()]);
      if (
        !final ||
        JSON.stringify(final) !== JSON.stringify(initial) ||
        latest?.pane_id !== pane ||
        latest?.shell_pid !== shell ||
        !alive() ||
        (!chain.includes(shell) && (await options.privateSeat?.(chain, pane, binding)) !== true)
      )
        return false;
      const current = await options.binding();
      if (!alive() || current?.socketPath !== binding.socketPath || current?.session !== binding.session)
        return false;
      // Pin only an admitted connection's identity. Every later check still
      // observes OS ownership, ancestry, the linked pane and registry afresh.
      owners.set(socket, initial.owner);
      return true;
    } catch {
      return false;
    }
  };
}

/** Project access additionally needs the live native foreground agent, not just its pane shell. */
export function localProjectProof(options: LocalFleetProofOptions) {
  const observe = createProjectProcessObserver(options);
  const observeSocket: NonNullable<LocalFleetProofOptions["observeSocket"]> =
    options.observeSocket ??
    ((socket, expected) =>
      observeSocketProcess(socket, options.processHelper ?? fleetProcessHelper(), expected));
  const owners = new WeakMap<Socket, NativeSocketOwner>();
  return async (socket: Socket, pane: string): Promise<ProjectProcessProof | undefined> => {
    if ((options.platform ?? process.platform) !== "darwin" || !/^w[\w]+:p[\w]+$/u.test(pane))
      return undefined;
    const clientPort = socket.remotePort;
    const serverPort = socket.localPort;
    const alive = () =>
      !socket.destroyed &&
      socket.readable &&
      socket.writable &&
      socket.remoteAddress === "127.0.0.1" &&
      socket.localAddress === "127.0.0.1" &&
      socket.remotePort === clientPort &&
      socket.localPort === serverPort;
    if (!alive() || !clientPort || !serverPort) return undefined;
    try {
      const binding = await options.binding();
      if (!binding) return undefined;
      const [proof, initial] = await Promise.all([
        observe("default", pane),
        observeSocket(socket, options.expectedOwner?.(socket) ?? owners.get(socket)),
      ]);
      const chain = initial?.ancestors.map((ancestor) => ancestor.pid) ?? [];
      if (
        !proof ||
        !initial ||
        chain.length === 0 ||
        !alive() ||
        binding.socketPath !== proof.binding.socketPath ||
        binding.session !== proof.binding.session
      )
        return undefined;
      // Native proof already brackets executable/session/foreground/lifetime reads.
      // Bind its shell to the socket ancestry without repeating the entire fleet proof.
      if (!chain.includes(proof.shell.pid) && (await options.privateSeat?.(chain, pane, binding)) !== true)
        return undefined;
      const direct = proof.processes.some((process) => chain.includes(process.pid));
      const privateSeat =
        !direct &&
        !proof.nativeSessionPending &&
        (await options.privateProjectSeat?.(chain, pane, binding, proof)) === true;
      if (!direct && !privateSeat) return undefined;
      const [final, finalProof] = await Promise.all([
        observeSocket(socket, initial.owner),
        observe("default", pane),
      ]);
      const finalChain = final?.ancestors.map((ancestor) => ancestor.pid) ?? [];
      if (
        !final ||
        JSON.stringify(final) !== JSON.stringify(initial) ||
        JSON.stringify(finalProof) !== JSON.stringify(proof) ||
        !alive()
      )
        return undefined;
      if (
        !finalChain.includes(proof.shell.pid) &&
        (await options.privateSeat?.(finalChain, pane, binding)) !== true
      )
        return undefined;
      if (privateSeat && (await options.privateProjectSeat?.(finalChain, pane, binding, proof)) !== true)
        return undefined;
      const current = await options.binding();
      if (!alive() || current?.socketPath !== binding.socketPath || current?.session !== binding.session)
        return undefined;
      owners.set(socket, initial.owner);
      return privateSeat ? { ...proof, privateSeat: true } : proof;
    } catch {
      return undefined;
    }
  };
}
