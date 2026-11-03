import { createHash } from "node:crypto";
import type {
  OperatorTerminalSession,
  OperatorTerminalObservationRequest,
  OperatorTerminalObservationResult,
  OperatorTerminalControlRequest,
  OperatorTerminalControlResult,
  OperatorTerminalInputRequest,
  OperatorTerminalInputResult,
} from "@clankie/protocol";
import { pinHerdrEnvironment, type ExecutionConnections } from "../herdr-session.ts";
import { focusHerdrTerminal, readTerminalCatalog } from "./herdr-census.ts";
import { createHerdrCore } from "./herdr-core.ts";
import {
  desktopTerminalAddress,
  readHerdrCoreCatalog,
  readHerdrCoreGrid,
  startHerdrCoreObserver,
} from "./herdr-core-terminals.ts";
import { HerdrTerminalStore } from "./herdr-terminal.ts";
import { HerdrTerminalControlStore } from "./herdr-terminal-control.ts";

interface Runtime {
  id: string;
  session: string;
  key: string;
  env: NodeJS.ProcessEnv;
  terminals: HerdrTerminalStore;
  controls: HerdrTerminalControlStore;
  nativeIds: Map<string, string>;
}

/** One existing observer/control store per pinned runtime; no terminal bytes enter conversations. */
export class RuntimeTerminals {
  private readonly runtimes = new Map<string, Runtime>();
  /** The desktop app's terminals, watched through its core (ADR 0319); only with `desktopSocket`. */
  private desktop: HerdrTerminalStore | undefined;
  private closed = false;
  private readonly stopChanges: (() => void) | undefined;
  private readonly options: {
    connections?: Pick<ExecutionConnections, "list" | "configuredBinding" | "onChange">;
    defaultAvailable?: () => boolean;
    /** The Herdr desktop app's core socket; its terminals join the catalog when given. */
    desktopSocket?: () => string;
  };
  constructor(options: RuntimeTerminals["options"] = {}) {
    this.options = options;
    this.stopChanges = options.connections?.onChange((id) => this.drop(id));
  }

  private drop(id: string) {
    const runtime = this.runtimes.get(id);
    runtime?.terminals.close();
    runtime?.controls.close();
    this.runtimes.delete(id);
  }

  private async binding(id: string) {
    if (this.options.connections) return this.options.connections.configuredBinding(id);
    // Standalone captain embeddings retain their explicitly selected process runtime.
    return id === "default" && this.options.defaultAvailable?.() !== false
      ? { session: "default", socketPath: process.env.HERDR_SOCKET_PATH }
      : undefined;
  }

  private async runtime(id: string): Promise<Runtime | undefined> {
    if (this.closed) return undefined;
    const binding = await this.binding(id);
    if (this.closed) return undefined;
    const key = binding === undefined ? undefined : JSON.stringify(binding);
    let runtime = this.runtimes.get(id);
    if (runtime && runtime.key !== key) {
      this.drop(id);
      runtime = undefined;
    }
    if (!binding || key === undefined) return undefined;
    if (!runtime) {
      const env = pinHerdrEnvironment({ ...process.env }, binding.socketPath);
      const controls = new HerdrTerminalControlStore({ env });
      runtime = {
        id,
        session: binding.session,
        key,
        env,
        controls,
        nativeIds: new Map(),
        terminals: new HerdrTerminalStore({
          env,
          readControlledGrid: (terminalId, surfaceClientId) =>
            controls.geometryFor(terminalId, surfaceClientId),
        }),
      };
      this.runtimes.set(id, runtime);
    }
    return runtime;
  }

  private async current(runtime: Runtime): Promise<boolean> {
    if ((await this.runtime(runtime.id)) === runtime) return true;
    // An in-flight attach can finish after another request closes this runtime.
    runtime.terminals.close();
    runtime.controls.close();
    return false;
  }

  private async catalogFor(runtime: Runtime, seatIds = false): Promise<OperatorTerminalSession[]> {
    const sessions = await readTerminalCatalog({ env: runtime.env });
    if (!(await this.current(runtime))) return [];
    runtime.nativeIds.clear();
    return sessions.map((session) => {
      // Default seat deep links already use native terminal IDs. Named connections
      // bind the address to both the runtime and endpoint, including after restart.
      const terminalId =
        runtime.id === "default"
          ? session.terminalId
          : `rt:${runtime.id}:${createHash("sha256")
              .update(JSON.stringify([runtime.key, session.terminalId]))
              .digest("hex")}`;
      runtime.nativeIds.set(terminalId, session.terminalId);
      return {
        ...session,
        terminalId,
        runtime: { id: runtime.id, session: runtime.session },
        // The census names a named fleet's seat `<fleet>/<native>` (ADR 0184).
        ...(seatIds
          ? { seatId: runtime.id === "default" ? session.terminalId : `${runtime.id}/${session.terminalId}` }
          : {}),
      };
    });
  }

  async catalog(options: { readonly seatIds?: boolean } = {}): Promise<OperatorTerminalSession[]> {
    const ids = this.options.connections
      ? (await this.options.connections.list()).filter((row) => row.enabled).map((row) => row.id)
      : ["default"];
    for (const id of this.runtimes.keys()) {
      if (ids.includes(id)) continue;
      this.drop(id);
    }
    const desktopSocket = this.options.desktopSocket;
    const [herdr, desktop] = await Promise.all([
      Promise.all(
        ids.map(async (id) => {
          const runtime = await this.runtime(id);
          return runtime ? this.catalogFor(runtime, options.seatIds === true) : [];
        }),
      ),
      desktopSocket === undefined || this.closed
        ? []
        : readHerdrCoreCatalog(desktopSocket(), { seatIds: options.seatIds === true }),
    ]);
    return [...herdr.flat(), ...desktop];
  }

  /** The store that watches the desktop app's terminals, made on first use. */
  private desktopStore(): HerdrTerminalStore | undefined {
    const socket = this.options.desktopSocket;
    if (socket === undefined || this.closed) return undefined;
    this.desktop ??= new HerdrTerminalStore({
      startObserver: (address, columns, rows) => startHerdrCoreObserver(socket(), address, columns, rows),
      readGrid: (address) => readHerdrCoreGrid(socket(), address),
      // The first paint carries the terminal's history; there is no separate pane read.
      readHistory: async () => undefined,
    });
    return this.desktop;
  }

  private async resolve(terminalId: string) {
    // A desktop-app terminal is only watched and shown; it has no control lease or input here.
    if (desktopTerminalAddress(terminalId) !== undefined) return undefined;
    const named = /^rt:([a-z][a-z0-9-]{0,63}):[a-f0-9]{64}$/u.exec(terminalId);
    if (terminalId.startsWith("rt:") && !named) return undefined;
    const runtime = await this.runtime(named?.[1] ?? "default");
    if (!runtime) return undefined;
    if (!named) return { runtime, nativeId: terminalId };
    // A device can resume a durable terminal address after a service restart.
    if (!runtime.nativeIds.has(terminalId)) await this.catalogFor(runtime);
    if (!(await this.current(runtime))) return undefined;
    const nativeId = runtime.nativeIds.get(terminalId);
    return nativeId === undefined ? undefined : { runtime, nativeId };
  }

  /**
   * A seat on a named fleet is `<fleet>/<native>` (ADR 0184), so its seat id can
   * be watched directly. Only for observation: control and input keep the
   * endpoint-bound `rt:` address, so a lease never follows a changed endpoint.
   */
  private async resolveSeat(terminalId: string) {
    const seat = /^([a-z][a-z0-9-]{0,63})\/([^/]+)$/u.exec(terminalId);
    if (!seat || seat[1] === "default") return this.resolve(terminalId);
    const runtime = await this.runtime(seat[1]!);
    return runtime ? { runtime, nativeId: seat[2]! } : undefined;
  }

  async tail(request: OperatorTerminalObservationRequest): Promise<OperatorTerminalObservationResult> {
    const address = desktopTerminalAddress(request.terminalId);
    if (address !== undefined) return this.tailDesktop(request, address);
    const target = await this.resolveSeat(request.terminalId);
    const unavailable = {
      schemaVersion: 1,
      status: "unavailable",
      terminalId: request.terminalId,
      surfaceClientId: request.surfaceClientId,
      reason: "herdr_unavailable",
    } as const;
    if (!target) return unavailable;
    const result = await target.runtime.terminals.tail({ ...request, terminalId: target.nativeId });
    if (!(await this.current(target.runtime))) return unavailable;
    return {
      ...result,
      terminalId: request.terminalId,
      ...(result.status === "page"
        ? { frames: result.frames.map((frame) => ({ ...frame, terminalId: request.terminalId })) }
        : {}),
    };
  }

  private async tailDesktop(
    request: OperatorTerminalObservationRequest,
    address: string,
  ): Promise<OperatorTerminalObservationResult> {
    const store = this.desktopStore();
    if (store === undefined)
      return {
        schemaVersion: 1,
        status: "unavailable",
        terminalId: request.terminalId,
        surfaceClientId: request.surfaceClientId,
        reason: "herdr_unavailable",
      };
    const result = await store.tail({ ...request, terminalId: address });
    return {
      ...result,
      terminalId: request.terminalId,
      ...(result.status === "page"
        ? { frames: result.frames.map((frame) => ({ ...frame, terminalId: request.terminalId })) }
        : {}),
    };
  }

  /**
   * The address Clankie's fleet-routed Herdr runner reads a terminal by: a
   * seat id as it is, a named connection's `rt:` address as `<connection>/<pane>`.
   * Unlike `tail`, that runner reaches ssh fleets too.
   */
  async paneAddress(terminalId: string): Promise<string | undefined> {
    if (/^([a-z][a-z0-9-]{0,63})\/([^/]+)$/u.test(terminalId)) return terminalId;
    if (!terminalId.startsWith("rt:")) return terminalId;
    const target = await this.resolve(terminalId);
    return target === undefined ? undefined : `${target.runtime.id}/${target.nativeId}`;
  }

  /** Bring a terminal to the front in its own Herdr; a seat id on a named fleet works as for `tail`. */
  async focus(terminalId: string): Promise<"focused" | "unavailable"> {
    const address = desktopTerminalAddress(terminalId);
    const desktopSocket = this.options.desktopSocket;
    if (address !== undefined) {
      if (desktopSocket === undefined || this.closed) return "unavailable";
      const shown = await createHerdrCore({ socketPath: desktopSocket() }).focus(address);
      return shown.status;
    }
    const target = await this.resolveSeat(terminalId);
    if (!target) return "unavailable";
    const focused = await focusHerdrTerminal(target.nativeId, { env: target.runtime.env });
    return focused && (await this.current(target.runtime)) ? "focused" : "unavailable";
  }

  async control(request: OperatorTerminalControlRequest): Promise<OperatorTerminalControlResult> {
    const target = await this.resolve(request.terminalId);
    const unavailable = {
      schemaVersion: 1,
      status: "unavailable",
      terminalId: request.terminalId,
      reason: "herdr_unavailable",
    } as const;
    if (!target) return unavailable;
    const result = await target.runtime.controls.control({ ...request, terminalId: target.nativeId });
    if (!(await this.current(target.runtime))) return unavailable;
    return result.status === "granted"
      ? { ...result, grant: { ...result.grant, terminalId: request.terminalId } }
      : { ...result, terminalId: request.terminalId };
  }

  async input(request: OperatorTerminalInputRequest): Promise<OperatorTerminalInputResult> {
    const target = await this.resolve(request.terminalId);
    if (!target)
      return {
        schemaVersion: 1,
        status: "unavailable",
        terminalId: request.terminalId,
        reason: "herdr_unavailable",
      };
    return {
      ...target.runtime.controls.input({ ...request, terminalId: target.nativeId }),
      terminalId: request.terminalId,
    };
  }

  close() {
    this.closed = true;
    this.stopChanges?.();
    this.desktop?.close();
    this.desktop = undefined;
    for (const id of this.runtimes.keys()) this.drop(id);
  }
}
