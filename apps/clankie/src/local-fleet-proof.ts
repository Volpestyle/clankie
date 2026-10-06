import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Socket } from "node:net";
import { pinHerdrEnvironment } from "./herdr-session.ts";
import type { HerdrBinding } from "@clankie/protocol";
import type { FleetProofRefusalReason } from "@clankie/protocol";
import { nativeRequest, NativePaneNotFoundError } from "./herdr-native-request.ts";
import type { NativeTransportReason } from "./native-process-transport.ts";
import { createProjectProcessObserver, type ProjectProcessProof } from "./project-process-proof.ts";
import {
  fleetProcessHelper,
  observeSocketProcess,
  type NativeSocketOwner,
  type NativeSocketProcess,
  type NativeProcessDiagnostic,
  nativeProcessStart,
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
  privateSeat?(
    ancestors: readonly number[],
    pane: string,
    binding: HerdrBinding,
    signal?: AbortSignal,
  ): Promise<boolean>;
  privateProjectSeat?(
    ancestors: readonly number[],
    pane: string,
    binding: HerdrBinding,
    proof: ProjectProcessProof,
    signal?: AbortSignal,
  ): Promise<boolean>;
  herdrBinary: string;
  run?: Run;
  platform?: string;
  processHelper?: string;
  /** Host observation seam; production always uses the fresh native census. */
  observeSocket?(
    socket: Socket,
    expected?: NativeSocketOwner,
    signal?: AbortSignal,
  ): Promise<NativeSocketProcess | undefined>;
  /** Server-owned additional lifetime pin. It can refuse, never grant admission. */
  expectedOwner?(socket: Socket): NativeSocketOwner | undefined;
  /** Server-owned opt-in diagnostics; fixed stages only, never caller authority. */
  diagnostics?(event: LocalFleetProofDiagnostic, pane?: string): void;
}

export type LocalFleetProofDiagnostic =
  | { source: "proof_success" }
  | { source: "native"; checkpoint: "initial" | "final"; event: NativeProcessDiagnostic }
  | { source: "transport"; reason: NativeTransportReason }
  | {
      source: "proof";
      reason: FleetProofRefusalReason;
    };

function diagnostic(options: LocalFleetProofOptions, event: LocalFleetProofDiagnostic, pane?: string) {
  try {
    void Promise.resolve(options.diagnostics?.(event, pane)).catch(() => {});
  } catch {
    /* Observation never changes admission. */
  }
}

/** macOS local proof. Unsupported platforms and disconnected sockets fail closed. */
export function localFleetProof(options: LocalFleetProofOptions) {
  const execute = options.run ?? run;
  const observe = options.observeSocket;
  const owners = new WeakMap<Socket, NativeSocketOwner>();
  return async (socket: Socket, pane: string, signal?: AbortSignal): Promise<boolean> => {
    signal?.throwIfAborted();
    const refuse = (reason: Extract<LocalFleetProofDiagnostic, { source: "proof" }>["reason"]) => {
      diagnostic(options, { source: "proof", reason }, pane);
      return false;
    };
    const snapshot = (checkpoint: "initial" | "final", expected?: NativeSocketOwner) =>
      observe !== undefined
        ? observe(socket, expected, signal)
        : observeSocketProcess(
            socket,
            options.processHelper ?? fleetProcessHelper(),
            expected,
            options.diagnostics === undefined
              ? undefined
              : (event) => diagnostic(options, { source: "native", checkpoint, event }, pane),
            (reason) => diagnostic(options, { source: "transport", reason }, pane),
            signal,
          );
    if ((options.platform ?? process.platform) !== "darwin") return refuse("unsupported_platform");
    if (!/^w[\w]+:p[\w]+$/u.test(pane)) return refuse("invalid_pane");
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
    if (!alive() || !clientPort || !serverPort) return refuse("closed_socket");
    try {
      const binding = await options.binding();
      signal?.throwIfAborted();
      if (!binding) return refuse("missing_binding");
      const initial = await snapshot("initial", options.expectedOwner?.(socket) ?? owners.get(socket));
      signal?.throwIfAborted();
      if (!initial) return refuse("native_initial_unavailable");
      if (!alive()) return refuse("closed_socket");
      const chain = initial.ancestors.map((ancestor) => ancestor.pid);
      const paneInfo = async () => {
        signal?.throwIfAborted();
        let result: unknown;
        try {
          result = options.run
            ? JSON.parse(
                await execute(
                  options.herdrBinary,
                  ["pane", "process-info", "--pane", pane],
                  pinHerdrEnvironment({ ...process.env }, binding.socketPath),
                ),
              )
            : await nativeRequest(
                binding,
                "pane.process_info",
                { pane_id: pane },
                { timeoutMs: 5_000, ...(signal ? { signal } : {}) },
              );
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof NativePaneNotFoundError) return undefined;
          throw error;
        }
        signal?.throwIfAborted();
        return (result as { result?: { process_info?: { pane_id: string; shell_pid: number } } })?.result
          ?.process_info;
      };
      const info = await paneInfo();
      if (info?.pane_id !== pane) return refuse("pane_unavailable");
      const shell = info.shell_pid;
      if (!Number.isSafeInteger(shell) || shell <= 1) return refuse("pane_unavailable");
      const admitted =
        chain.includes(shell) || (await options.privateSeat?.(chain, pane, binding, signal)) === true;
      signal?.throwIfAborted();
      if (!admitted) return refuse("not_member");
      // Drain both owned observations before returning, even if cancellation closes control first.
      const [finalRead, latestRead] = await Promise.allSettled([
        snapshot("final", initial.owner),
        paneInfo(),
      ]);
      signal?.throwIfAborted();
      if (finalRead.status !== "fulfilled" || latestRead.status !== "fulfilled")
        return refuse("observation_failed");
      const final = finalRead.value,
        latest = latestRead.value;
      if (!final) return refuse("native_final_unavailable");
      if (JSON.stringify(final) !== JSON.stringify(initial)) return refuse("snapshot_changed");
      if (latest?.pane_id !== pane || latest?.shell_pid !== shell) return refuse("pane_changed");
      if (!alive()) return refuse("closed_socket");
      if (!chain.includes(shell) && (await options.privateSeat?.(chain, pane, binding, signal)) !== true)
        return refuse("private_seat_expired");
      const current = await options.binding();
      signal?.throwIfAborted();
      if (!alive()) return refuse("closed_socket");
      if (current?.socketPath !== binding.socketPath || current?.session !== binding.session)
        return refuse("binding_changed");
      // Pin only an admitted connection's identity. Every later check still
      // observes OS ownership, ancestry, the linked pane and registry afresh.
      owners.set(socket, initial.owner);
      diagnostic(options, { source: "proof_success" }, pane);
      return true;
    } catch {
      signal?.throwIfAborted();
      return refuse("observation_failed");
    }
  };
}

/** Project access additionally needs the live native foreground agent, not just its pane shell. */
export function localProjectProof(options: LocalFleetProofOptions) {
  const observeSocket = (
    socket: Socket,
    checkpoint: "initial" | "final",
    pane: string,
    expected?: NativeSocketOwner,
    signal?: AbortSignal,
  ) =>
    options.observeSocket !== undefined
      ? options.observeSocket(socket, expected, signal)
      : observeSocketProcess(
          socket,
          options.processHelper ?? fleetProcessHelper(),
          expected,
          options.diagnostics === undefined
            ? undefined
            : (event) => diagnostic(options, { source: "native", checkpoint, event }, pane),
          (reason) => diagnostic(options, { source: "transport", reason }, pane),
          signal,
        );
  const owners = new WeakMap<Socket, NativeSocketOwner>();
  return async (
    socket: Socket,
    pane: string,
    signal?: AbortSignal,
  ): Promise<ProjectProcessProof | undefined> => {
    signal?.throwIfAborted();
    const observe = createProjectProcessObserver({
      ...options,
      ...(signal ? { signal } : {}),
      ...(options.diagnostics === undefined
        ? {}
        : {
            nativeDiagnostics: (
              event: NativeProcessDiagnostic,
              checkpoint: "initial" | "final",
              pane: string,
            ) => diagnostic(options, { source: "native", checkpoint, event }, pane),
            nativeTransportDiagnostics: (reason: NativeTransportReason, pane: string) =>
              diagnostic(options, { source: "transport", reason }, pane),
          }),
    });
    const refuse = (reason: Extract<LocalFleetProofDiagnostic, { source: "proof" }>["reason"]) => {
      diagnostic(options, { source: "proof", reason }, pane);
      return undefined;
    };
    if ((options.platform ?? process.platform) !== "darwin") return refuse("unsupported_platform");
    if (!/^w[\w]+:p[\w]+$/u.test(pane)) return refuse("invalid_pane");
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
    if (!alive() || !clientPort || !serverPort) return refuse("closed_socket");
    try {
      const binding = await options.binding();
      signal?.throwIfAborted();
      if (!binding) return refuse("missing_binding");
      // Keep the full-census phases clear of our own short-lived Herdr/helper
      // children. Project observations bracket both socket checkpoints, while
      // those socket checkpoints bracket the private-registry checks below.
      const proof = await observe("default", pane);
      signal?.throwIfAborted();
      if (!proof) return refuse("pane_unavailable");
      const initial = await observeSocket(
        socket,
        "initial",
        pane,
        options.expectedOwner?.(socket) ?? owners.get(socket),
        signal,
      );
      signal?.throwIfAborted();
      if (!initial) return refuse("native_initial_unavailable");
      const chain = initial.ancestors.map((ancestor) => ancestor.pid);
      if (!alive()) return refuse("closed_socket");
      if (
        !proof ||
        !initial ||
        chain.length === 0 ||
        binding.socketPath !== proof.binding.socketPath ||
        binding.session !== proof.binding.session
      )
        return refuse("binding_changed");
      // Native proof already brackets executable/session/foreground/lifetime reads.
      // Bind its shell to the socket ancestry without repeating the entire fleet proof.
      const hasLifetime = (snapshot: NativeSocketProcess, process: { pid: number; startTime: string }) =>
        snapshot.ancestors.some(
          (ancestor) =>
            ancestor.pid === process.pid && nativeProcessStart(ancestor.birth) === process.startTime,
        );
      const directShell = hasLifetime(initial, proof.shell);
      if (!directShell && (await options.privateSeat?.(chain, pane, binding, signal)) !== true)
        return refuse("not_member");
      signal?.throwIfAborted();
      // A private registry may supply an alternate server ancestry; it never
      // excuses conflicting kernel lifetimes for a PID already in this chain.
      if (
        (chain.includes(proof.shell.pid) && !directShell) ||
        proof.processes.some((process) => chain.includes(process.pid) && !hasLifetime(initial, process))
      )
        return refuse("snapshot_changed");
      const direct = proof.processes.some((process) => hasLifetime(initial, process));
      const privateSeat =
        !direct &&
        !proof.nativeSessionPending &&
        (await options.privateProjectSeat?.(chain, pane, binding, proof, signal)) === true;
      signal?.throwIfAborted();
      if (!direct && !privateSeat) return refuse("not_member");
      const final = await observeSocket(socket, "final", pane, initial.owner, signal);
      signal?.throwIfAborted();
      if (!final) return refuse("native_final_unavailable");
      const finalProof = await observe("default", pane);
      signal?.throwIfAborted();
      const finalChain = final?.ancestors.map((ancestor) => ancestor.pid) ?? [];
      if (!alive()) return refuse("closed_socket");
      if (
        !final ||
        JSON.stringify(final) !== JSON.stringify(initial) ||
        JSON.stringify(finalProof) !== JSON.stringify(proof)
      )
        return refuse("snapshot_changed");
      if (
        !hasLifetime(final, proof.shell) &&
        (await options.privateSeat?.(finalChain, pane, binding, signal)) !== true
      )
        return refuse("private_seat_expired");
      signal?.throwIfAborted();
      if (
        privateSeat &&
        (await options.privateProjectSeat?.(finalChain, pane, binding, proof, signal)) !== true
      )
        return refuse("private_seat_expired");
      signal?.throwIfAborted();
      const current = await options.binding();
      signal?.throwIfAborted();
      if (!alive()) return refuse("closed_socket");
      if (current?.socketPath !== binding.socketPath || current?.session !== binding.session)
        return refuse("binding_changed");
      owners.set(socket, initial.owner);
      diagnostic(options, { source: "proof_success" }, pane);
      return privateSeat ? { ...proof, privateSeat: true } : proof;
    } catch {
      signal?.throwIfAborted();
      return refuse("observation_failed");
    }
  };
}
