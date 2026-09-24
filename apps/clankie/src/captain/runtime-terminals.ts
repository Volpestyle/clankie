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
import { readTerminalCatalog } from "./herdr-census.ts";
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
  private closed = false;
  private readonly stopChanges: (() => void) | undefined;
  private readonly options: {
    connections?: Pick<ExecutionConnections, "list" | "configuredBinding" | "onChange">;
    defaultAvailable?: () => boolean;
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

  private async catalogFor(runtime: Runtime): Promise<OperatorTerminalSession[]> {
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
      return { ...session, terminalId, runtime: { id: runtime.id, session: runtime.session } };
    });
  }

  async catalog(): Promise<OperatorTerminalSession[]> {
    const ids = this.options.connections
      ? (await this.options.connections.list()).filter((row) => row.enabled).map((row) => row.id)
      : ["default"];
    for (const id of this.runtimes.keys()) {
      if (ids.includes(id)) continue;
      this.drop(id);
    }
    return (
      await Promise.all(
        ids.map(async (id) => {
          const runtime = await this.runtime(id);
          return runtime ? this.catalogFor(runtime) : [];
        }),
      )
    ).flat();
  }

  private async resolve(terminalId: string) {
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

  async tail(request: OperatorTerminalObservationRequest): Promise<OperatorTerminalObservationResult> {
    const target = await this.resolve(request.terminalId);
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
    for (const id of this.runtimes.keys()) this.drop(id);
  }
}
