import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Socket } from "node:net";
import { pinHerdrEnvironment } from "./herdr-session.ts";
import type { HerdrBinding } from "@clankie/protocol";

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

export interface LocalFleetProofOptions {
  binding(): Promise<HerdrBinding | undefined>;
  /** Server-owned private app-server registry; never supplied by a caller. */
  privateSeat?(ancestors: readonly number[], pane: string, binding: HerdrBinding): Promise<boolean>;
  herdrBinary: string;
  run?: Run;
  platform?: string;
}

/** macOS local proof. Unsupported platforms and disconnected sockets fail closed. */
export function localFleetProof(options: LocalFleetProofOptions) {
  const execute = options.run ?? run;
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
      const owner = async () =>
        clientPid(
          await execute("/usr/sbin/lsof", ["-nP", "-a", `-iTCP:${serverPort}`, "-sTCP:ESTABLISHED", "-Fpn"]),
          clientPort,
          serverPort,
        );
      const pid = await owner();
      if (!pid || !alive()) return false;
      const chain = ancestors(await execute("/bin/ps", ["-axo", "pid=,ppid="]), pid);
      if (chain.length === 0) return false;
      const result = JSON.parse(
        await execute(
          options.herdrBinary,
          ["pane", "process-info", "--pane", pane],
          pinHerdrEnvironment({ ...process.env }, binding.socketPath),
        ),
      );
      const info = result?.result?.process_info;
      if (info?.pane_id !== pane) return false;
      const shell = info.shell_pid;
      if (!Number.isSafeInteger(shell) || shell <= 1) return false;
      const admitted = chain.includes(shell) || (await options.privateSeat?.(chain, pane, binding)) === true;
      const current = await options.binding();
      return (
        admitted &&
        alive() &&
        current?.socketPath === binding.socketPath &&
        current?.session === binding.session &&
        (await owner()) === pid &&
        alive()
      );
    } catch {
      return false;
    }
  };
}
