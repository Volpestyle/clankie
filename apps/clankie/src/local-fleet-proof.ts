import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Socket } from "node:net";
import { pinHerdrEnvironment } from "./herdr-session.ts";
import type { HerdrBinding } from "@clankie/protocol";
import type { FleetProofRefusalReason } from "@clankie/protocol";
import { nativeRequest, NativePaneNotFoundError } from "./herdr-native-request.ts";
import type { NativeTransportReason } from "./native-process-transport.ts";
import { FleetAdmissionUnavailableError } from "./local-fleet-admission.ts";
import {
  createProjectProcessObserver,
  type ProjectProcessProof,
  type ProjectProcessRefusal,
} from "./project-process-proof.ts";
import type { LocalFleetProofRequestContext } from "./local-fleet-link.ts";
import {
  fleetProcessHelper,
  observeSocketProcess,
  type NativeSocketOwner,
  type NativeSocketProcess,
  type NativeProcessDiagnostic,
  type NativeBirth,
  nativeProcessStart,
  observeNativeBirth,
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
  "launcher" | "canonical" | "harnessBinary"
> {
  binding(): Promise<HerdrBinding | undefined>;
  /**
   * The Herdr desktop app's core, for a seat in one of its terminals (ADR 0319):
   * its socket as a binding, so a proof stays bound to the core it was made against.
   */
  coreBinding?(): Promise<HerdrBinding | undefined>;
  /**
   * The live terminal Clankie started at this core address, with its program's pid;
   * null when the core has no such terminal, or it isn't a live Clankie seat.
   */
  coreTerminal?(
    binding: HerdrBinding,
    address: string,
    signal?: AbortSignal,
  ): Promise<{ readonly pid: number } | null>;
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
  /**
   * Host lifetime seam for a proven connection's owner and ancestors; production
   * reads fresh native births. A host that replaces observeSocket without this
   * gets no connection reuse: every request runs its injected observation.
   */
  observeBirth?(pid: number, signal?: AbortSignal): Promise<NativeBirth | undefined>;
  /** Server-owned additional lifetime pin. It can refuse, never grant admission. */
  expectedOwner?(socket: Socket): NativeSocketOwner | undefined;
  /** Server-owned opt-in diagnostics; fixed stages only, never caller authority. */
  diagnostics?(
    event: LocalFleetProofDiagnostic,
    pane?: string,
    context?: LocalFleetProofRequestContext,
  ): void;
}

export type LocalFleetProofDiagnostic =
  | { source: "proof_success" }
  | { source: "socket_owner"; owner: NativeSocketOwner }
  | { source: "project"; event: ProjectProcessRefusal }
  | { source: "native"; checkpoint: "initial" | "final"; event: NativeProcessDiagnostic }
  | { source: "transport"; reason: NativeTransportReason }
  | {
      source: "proof";
      reason: FleetProofRefusalReason;
    };

function diagnostic(
  options: LocalFleetProofOptions,
  event: LocalFleetProofDiagnostic,
  pane?: string,
  context?: LocalFleetProofRequestContext,
) {
  try {
    void Promise.resolve(options.diagnostics?.(event, pane, context)).catch(() => {});
  } catch {
    /* Observation never changes admission. */
  }
}

/** Kernel-backed local proof. Unsupported platforms and disconnected sockets fail closed. */
export function localFleetProof(options: LocalFleetProofOptions) {
  return createLocalFleetProof(options, false);
}

/** Admission distinguishes unavailable observations from a proven refusal. */
export function localFleetAdmissionProof(options: LocalFleetProofOptions) {
  return createLocalFleetProof(options, true);
}

/**
 * A connection's successful proof (VUH-2389): the kernel owner and the ancestry
 * that linked it to the pane's shell or private seat, with the pane and Herdr
 * binding it was proven against. It never outlives its socket.
 */
interface ConnectionProof {
  readonly pane: string;
  readonly owner: NativeSocketOwner;
  readonly shell: number;
  /** Owner first, up to and including the shell; the whole chain for a private seat. */
  readonly lineage: NativeSocketProcess["ancestors"];
  readonly privateSeat: boolean;
  readonly binding: Pick<HerdrBinding, "socketPath" | "session">;
}

const sameOwner = (a: NativeSocketOwner, b: NativeSocketOwner) =>
  a.pid === b.pid &&
  a.uid === b.uid &&
  a.birth[0] === b.birth[0] &&
  a.birth[1] === b.birth[1] &&
  a.socket === b.socket &&
  a.kernelIdentity === b.kernelIdentity;

function createLocalFleetProof(options: LocalFleetProofOptions, admission: boolean) {
  const execute = options.run ?? run;
  const observe = options.observeSocket;
  const owners = new WeakMap<Socket, NativeSocketOwner>();
  const proven = new WeakMap<Socket, ConnectionProof>();
  const observeBirth =
    options.observeBirth ??
    (observe === undefined
      ? (pid: number, signal?: AbortSignal) =>
          observeNativeBirth(pid, signal, options.processHelper ?? fleetProcessHelper())
      : undefined);
  return async (
    socket: Socket,
    pane: string,
    signal?: AbortSignal,
    context?: LocalFleetProofRequestContext,
  ): Promise<boolean> => {
    const emit = (event: LocalFleetProofDiagnostic) => diagnostic(options, event, pane, context);
    signal?.throwIfAborted();
    let refusalRecorded = false;
    const refuse = (reason: Extract<LocalFleetProofDiagnostic, { source: "proof" }>["reason"]) => {
      emit({ source: "proof", reason });
      refusalRecorded = true;
      if (
        admission &&
        reason !== "unsupported_platform" &&
        reason !== "unsupported_pid_namespace" &&
        reason !== "invalid_pane" &&
        reason !== "pane_unavailable" &&
        reason !== "pane_moved" &&
        reason !== "not_member" &&
        reason !== "private_seat_expired"
      )
        throw new FleetAdmissionUnavailableError("Local fleet observations are unavailable");
      return false;
    };
    let nativeReason: FleetProofRefusalReason | undefined;
    const snapshot = (checkpoint: "initial" | "final", expected?: NativeSocketOwner) =>
      observe !== undefined
        ? observe(socket, expected, signal)
        : observeSocketProcess(
            socket,
            options.processHelper ?? fleetProcessHelper(),
            expected,
            (event) => {
              nativeReason =
                !event.retry &&
                (event.reason === "caller_exited" ||
                  event.reason === "ancestor_exited" ||
                  event.reason === "unsupported_pid_namespace")
                  ? event.reason
                  : undefined;
              emit({ source: "native", checkpoint, event });
            },
            (reason) => emit({ source: "transport", reason }),
            signal,
          );
    if (!["darwin", "linux"].includes(options.platform ?? process.platform))
      return refuse("unsupported_platform");
    // A Herdr pane, or one of Clankie's own terminals in the Herdr desktop app (ADR 0319).
    const core = /^herdr-core\/(t\d+)$/u.exec(pane)?.[1];
    if (
      core === undefined
        ? !/^w[\w]+:p[\w]+$/u.test(pane)
        : options.coreTerminal === undefined || options.coreBinding === undefined
    )
      return refuse("invalid_pane");
    const bindingOf = () => (core === undefined ? options.binding() : options.coreBinding!());
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
    const paneInfo = async (binding: HerdrBinding) => {
      signal?.throwIfAborted();
      if (core !== undefined) {
        // The terminal's own program is its shell: a hire's harness execs in its place.
        const terminal = await options.coreTerminal!(binding, core, signal);
        signal?.throwIfAborted();
        return terminal === null ? null : { pane_id: pane, shell_pid: terminal.pid };
      }
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
        if (error instanceof NativePaneNotFoundError) return null;
        throw error;
      }
      signal?.throwIfAborted();
      return (result as { result?: { process_info?: { pane_id: string; shell_pid: number } } })?.result
        ?.process_info;
    };
    // A later request on a proven connection skips the whole-machine census.
    // It still needs this live socket, the same pane claim, Herdr binding and
    // shell, and its lineage at their proven births: a parent link changes only
    // when that parent exits. A private seat must still be registered within
    // the unbroken part of its chain (ancestors above it, such as a root login,
    // need not be observable). Any doubt discards the connection's proof and
    // runs the full fresh proof.
    const reuse = async (held: ConnectionProof) => {
      const expected = options.expectedOwner?.(socket);
      if (held.pane !== pane || observeBirth === undefined || (expected && !sameOwner(expected, held.owner)))
        return false;
      try {
        const binding = await bindingOf();
        signal?.throwIfAborted();
        if (binding?.socketPath !== held.binding.socketPath || binding?.session !== held.binding.session)
          return false;
        const [births, info] = await Promise.all([
          Promise.all(held.lineage.map((process) => observeBirth(process.pid, signal))),
          paneInfo(binding),
        ]);
        signal?.throwIfAborted();
        const unbroken = births.findIndex(
          (birth, index) =>
            birth === undefined ||
            birth[0] !== held.lineage[index]!.birth[0] ||
            birth[1] !== held.lineage[index]!.birth[1] ||
            birth.kernelIdentity !== held.lineage[index]!.kernelIdentity,
        );
        const intact = unbroken < 0 ? held.lineage.length : unbroken;
        if (info?.pane_id !== pane || info?.shell_pid !== held.shell || intact === 0) return false;
        if (!held.privateSeat && intact !== held.lineage.length) return false;
        if (
          held.privateSeat &&
          (await options.privateSeat?.(
            held.lineage.slice(0, intact).map((process) => process.pid),
            pane,
            binding,
            signal,
          )) !== true
        )
          return false;
        const current = await bindingOf();
        signal?.throwIfAborted();
        return (
          alive() &&
          proven.get(socket) === held &&
          current?.socketPath === held.binding.socketPath &&
          current?.session === held.binding.session
        );
      } catch {
        signal?.throwIfAborted();
        return false;
      }
    };
    const held = proven.get(socket);
    if (held !== undefined) {
      if (await reuse(held)) return true;
      proven.delete(socket);
      if (!alive()) return refuse("closed_socket");
    }
    try {
      const binding = await bindingOf();
      signal?.throwIfAborted();
      if (!binding) return refuse("missing_binding");
      const initial = await snapshot("initial", options.expectedOwner?.(socket) ?? owners.get(socket));
      signal?.throwIfAborted();
      if (!initial) return refuse(nativeReason ?? "native_initial_unavailable");
      emit({ source: "socket_owner", owner: initial.owner });
      if (!alive()) return refuse("closed_socket");
      const chain = initial.ancestors.map((ancestor) => ancestor.pid);
      const info = await paneInfo(binding);
      if (info === null) return refuse("pane_unavailable");
      // Herdr resolves a moved pane's old ID to the pane under its new ID.
      if (info?.pane_id !== pane)
        return refuse(typeof info?.pane_id === "string" ? "pane_moved" : "observation_failed");
      const shell = info.shell_pid;
      if (!Number.isSafeInteger(shell) || shell <= 1) return refuse("observation_failed");
      const admitted =
        chain.includes(shell) || (await options.privateSeat?.(chain, pane, binding, signal)) === true;
      signal?.throwIfAborted();
      if (!admitted) return refuse("not_member");
      // Drain both owned observations before returning, even if cancellation closes control first.
      const [finalRead, latestRead] = await Promise.allSettled([
        snapshot("final", initial.owner),
        paneInfo(binding),
      ]);
      signal?.throwIfAborted();
      if (finalRead.status !== "fulfilled" || latestRead.status !== "fulfilled")
        return refuse("observation_failed");
      const final = finalRead.value,
        latest = latestRead.value;
      if (!final) return refuse(nativeReason ?? "native_final_unavailable");
      if (JSON.stringify(final) !== JSON.stringify(initial)) return refuse("snapshot_changed");
      if (latest?.pane_id !== pane || latest?.shell_pid !== shell) return refuse("pane_changed");
      if (!alive()) return refuse("closed_socket");
      if (!chain.includes(shell) && (await options.privateSeat?.(chain, pane, binding, signal)) !== true)
        return refuse("private_seat_expired");
      const current = await bindingOf();
      signal?.throwIfAborted();
      if (!alive()) return refuse("closed_socket");
      if (current?.socketPath !== binding.socketPath || current?.session !== binding.session)
        return refuse("binding_changed");
      // Pin the admitted connection's identity, and bind this proof to it for
      // later requests on the same socket (reuse above).
      owners.set(socket, initial.owner);
      const direct = chain.indexOf(shell);
      proven.set(socket, {
        pane,
        owner: initial.owner,
        shell,
        lineage: direct < 0 ? initial.ancestors : initial.ancestors.slice(0, direct + 1),
        privateSeat: direct < 0,
        binding: { socketPath: binding.socketPath, session: binding.session },
      });
      emit({ source: "proof_success" });
      return true;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof FleetAdmissionUnavailableError) {
        if (!refusalRecorded) emit({ source: "proof", reason: "observation_failed" });
        throw error;
      }
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
    context?: LocalFleetProofRequestContext,
    report?: (event: NativeProcessDiagnostic) => void,
  ) =>
    options.observeSocket !== undefined
      ? options.observeSocket(socket, expected, signal)
      : observeSocketProcess(
          socket,
          options.processHelper ?? fleetProcessHelper(),
          expected,
          (event) => {
            report?.(event);
            diagnostic(options, { source: "native", checkpoint, event }, pane, context);
          },
          (reason) => diagnostic(options, { source: "transport", reason }, pane, context),
          signal,
        );
  const owners = new WeakMap<Socket, NativeSocketOwner>();
  return async (
    socket: Socket,
    pane: string,
    signal?: AbortSignal,
    context?: LocalFleetProofRequestContext,
  ): Promise<ProjectProcessProof | undefined> => {
    const emit = (event: LocalFleetProofDiagnostic) => diagnostic(options, event, pane, context);
    let projectRefusal: ProjectProcessRefusal | undefined;
    let nativeReason: FleetProofRefusalReason | undefined;
    const report = (event: NativeProcessDiagnostic) => {
      nativeReason =
        !event.retry &&
        (event.reason === "caller_exited" ||
          event.reason === "ancestor_exited" ||
          event.reason === "unsupported_pid_namespace")
          ? event.reason
          : undefined;
    };
    signal?.throwIfAborted();
    const observe = createProjectProcessObserver({
      ...options,
      refusal: (event) => {
        projectRefusal = event;
        emit({ source: "project", event });
      },
      ...(signal ? { signal } : {}),
      ...(options.diagnostics === undefined
        ? {}
        : {
            nativeDiagnostics: (
              event: NativeProcessDiagnostic,
              checkpoint: "initial" | "final",
              pane: string,
            ) => diagnostic(options, { source: "native", checkpoint, event }, pane, context),
            nativeTransportDiagnostics: (reason: NativeTransportReason, pane: string) =>
              diagnostic(options, { source: "transport", reason }, pane, context),
          }),
    });
    const refuse = (reason: Extract<LocalFleetProofDiagnostic, { source: "proof" }>["reason"]) => {
      emit({ source: "proof", reason });
      return undefined;
    };
    if (!["darwin", "linux"].includes(options.platform ?? process.platform))
      return refuse("unsupported_platform");
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
      if (!proof) return refuse(projectRefusalReason(projectRefusal));
      const initial = await observeSocket(
        socket,
        "initial",
        pane,
        options.expectedOwner?.(socket) ?? owners.get(socket),
        signal,
        context,
        report,
      );
      signal?.throwIfAborted();
      if (!initial) return refuse(nativeReason ?? "native_initial_unavailable");
      emit({ source: "socket_owner", owner: initial.owner });
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
            ancestor.pid === process.pid &&
            nativeProcessStart(ancestor.birth, ancestor.kernelIdentity) === process.startTime,
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
      const final = await observeSocket(socket, "final", pane, initial.owner, signal, context, report);
      signal?.throwIfAborted();
      if (!final) return refuse(nativeReason ?? "native_final_unavailable");
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
      emit({ source: "proof_success" });
      return privateSeat ? { ...proof, privateSeat: true } : proof;
    } catch {
      signal?.throwIfAborted();
      return refuse("observation_failed");
    }
  };
}

function projectRefusalReason(event: ProjectProcessRefusal | undefined): FleetProofRefusalReason {
  switch (event?.reason) {
    case "pane_unavailable":
      return "pane_unavailable";
    case "pane_moved":
      return "pane_moved";
    case "binding_unavailable":
      return "missing_binding";
    case "native_initial_unavailable":
      return "native_initial_unavailable";
    case "native_final_unavailable":
      return "native_final_unavailable";
    case "process_changed":
      return "snapshot_changed";
    case "session_changed":
      return "pane_changed";
    case "binding_changed":
      return "binding_changed";
    default:
      return "observation_failed";
  }
}
