import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  AgentObservationSchema,
  type AdoptedWorkerBinding,
  type AgentObservation,
  type AgentReportedStatus,
  type Harness,
} from "@clankie/protocol";
import {
  decodeTerminalBytes,
  type ControlLease,
  type TerminalCapabilities,
  type TerminalFrame,
  type TerminalProvider,
  type TerminalSession,
} from "@clankie/terminal-protocol";
import { ControlLeaseManager } from "./control-leases.ts";
import type { TerminalSourceProvider } from "./terminal-source.ts";
import {
  TerminalManager,
  type TerminalClosure,
  type TerminalObservation,
  type TerminalResumeDisposition,
  type TerminalSnapshotProjection,
  type TerminalTransport,
} from "./terminals.ts";

const MAX_HERDR_LINE_BYTES = 24 * 1024 * 1024;
const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 40;
const DEFAULT_SEED_ATTEMPTS = 8;
const DEFAULT_SEED_QUIET_MS = 10;
const execFileAsync = promisify(execFile);

export type HerdrTerminalErrorCode =
  | "control_unavailable"
  | "invalid_input"
  | "not_found"
  | "protocol_error"
  | "seed_unstable"
  | "sequence_discontinuity"
  | "transport_lost";

/** Typed, redacted adapter failure. Messages never include socket paths or Herdr private identity. */
export class HerdrTerminalError extends Error {
  public readonly code: HerdrTerminalErrorCode;
  public readonly retryable: boolean;

  public constructor(code: HerdrTerminalErrorCode, retryable = false) {
    super(`Herdr terminal source failed: ${code}`);
    this.name = "HerdrTerminalError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface HerdrPaneSummary {
  /** Session-local and reusable; used only for Herdr requests. */
  paneId: string;
  /** Stable Herdr terminal identity; becomes the provider-neutral terminalId. */
  terminalId: string;
  /** Presentation-only label. Paths and agent session identifiers are never retained. */
  title: string;
}

export interface HerdrVisibleState {
  paneId: string;
  ansi: string;
  truncated: boolean;
}

export interface HerdrAttachChunk {
  paneId: string;
  sequence: number;
  data: string;
}

export interface HerdrAttachment {
  stream: AsyncIterable<HerdrAttachChunk>;
  close(): void;
}

/** Narrow protocol surface; fake transports freeze adapter behavior without a Herdr dependency. */
export interface HerdrTransport {
  listPanes(): Promise<HerdrPaneSummary[]>;
  readVisible(paneId: string): Promise<HerdrVisibleState>;
  attachPane(paneId: string, signal: AbortSignal): Promise<HerdrAttachment>;
  sendInput(paneId: string, text: string): Promise<void>;
}

/**
 * The census view of the same transport (ADR 0078), kept separate from
 * `HerdrTransport` because it answers a different question on a different
 * plane: `HerdrTransport` serves the observe-only terminal data plane, which
 * strips paths and session identifiers by design, while the census serves an
 * authenticated runner-owned surface whose entire job is to say which agents
 * are running and where. Neither ever carries terminal bytes.
 */
export interface HerdrAgentSource {
  listAgents(): Promise<AgentObservation[]>;
  /**
   * Deliver bounded operator-parity text to the pane hosting a terminal.
   * Takes the full adoption binding, never a pane id: pane ids are session-local
   * and reusable, so every identity field is re-resolved at delivery time (ADR
   * 0078). A binding the transport can no longer prove returns `terminal_gone`
   * rather than being guessed at — sending steering into the wrong agent is
   * worse than not sending it.
   */
  sendToAgent(binding: AdoptedWorkerBinding, text: string): Promise<"delivered" | "terminal_gone">;
}

export interface HerdrSocketTransportOptions {
  socketPath: string;
  /** Stable non-secret name for this Herdr session (for example `default`). */
  instanceId?: string;
  connect?: (socketPath: string) => Socket;
  resolveWorkspaceRoot?: (cwd: string) => Promise<string>;
}

/** Strict NDJSON client for Herdr's documented local socket protocol. */
export class HerdrSocketTransport implements HerdrTransport {
  private readonly socketPath: string;
  private readonly instanceId: string;
  private readonly connect: (socketPath: string) => Socket;
  private readonly resolveWorkspaceRoot: (cwd: string) => Promise<string>;

  public constructor(options: HerdrSocketTransportOptions) {
    if (options.socketPath.trim().length === 0) throw new HerdrTerminalError("transport_lost", true);
    this.socketPath = options.socketPath;
    this.instanceId =
      options.instanceId ??
      `socket-${createHash("sha256").update(options.socketPath).digest("hex").slice(0, 16)}`;
    this.connect = options.connect ?? ((socketPath) => createConnection({ path: socketPath }));
    this.resolveWorkspaceRoot = options.resolveWorkspaceRoot ?? canonicalWorkspaceRoot;
  }

  public async listPanes(): Promise<HerdrPaneSummary[]> {
    const result = await this.request("pane.list", {});
    if (!isRecord(result) || result.type !== "pane_list" || !Array.isArray(result.panes)) {
      throw new HerdrTerminalError("protocol_error");
    }
    const seen = new Set<string>();
    return result.panes.map((value) => {
      if (!isRecord(value)) throw new HerdrTerminalError("protocol_error");
      const paneId = requiredString(value.pane_id);
      const terminalId = requiredString(value.terminal_id);
      if (seen.has(terminalId)) throw new HerdrTerminalError("protocol_error");
      seen.add(terminalId);
      const label = optionalString(value.label) ?? optionalString(value.title) ?? "Herdr pane";
      return { paneId, terminalId, title: safeTitle(label, paneId) };
    });
  }

  /**
   * Census listing (ADR 0078). Reuses the same `pane.list` call as
   * `listPanes` but keeps the structured agent fields the terminal plane drops.
   * A pane the parser cannot understand is omitted rather than guessed at: a
   * census entry that misstates which agent occupies a terminal is worse than a
   * census that admits it saw one fewer.
   */
  public async listAgents(): Promise<AgentObservation[]> {
    const result = await this.request("pane.list", {});
    if (!isRecord(result) || result.type !== "pane_list" || !Array.isArray(result.panes)) {
      throw new HerdrTerminalError("protocol_error");
    }
    const observations: AgentObservation[] = [];
    const seen = new Set<string>();
    const workspaceRoots = new Map<string, Promise<string>>();
    for (const pane of result.panes) {
      if (!isRecord(pane)) continue;
      const cwd = optionalString(pane.cwd);
      let workspaceRoot: string | undefined;
      if (cwd !== undefined) {
        const pending = workspaceRoots.get(cwd) ?? this.resolveWorkspaceRoot(cwd);
        workspaceRoots.set(cwd, pending);
        workspaceRoot = await pending;
      }
      const observation = herdrPaneToAgentObservation(pane, {
        transportInstanceId: this.instanceId,
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      });
      if (!observation || seen.has(observation.terminalId)) continue;
      seen.add(observation.terminalId);
      observations.push(observation);
    }
    return observations;
  }

  /** Re-resolves and revalidates the full agent binding, then delivers (ADR 0078). */
  public async sendToAgent(
    binding: AdoptedWorkerBinding,
    text: string,
  ): Promise<"delivered" | "terminal_gone"> {
    if (binding.transportInstanceId !== this.instanceId) return "terminal_gone";
    const observation = (await this.listAgents()).find((candidate) =>
      matchesAdoptedBinding(candidate, binding),
    );
    if (!observation) return "terminal_gone";
    const result = await this.request("agent.prompt", {
      target: binding.terminalId,
      text,
      wait: null,
    });
    if (!isRecord(result) || result.type !== "agent_prompted") {
      throw new HerdrTerminalError("protocol_error");
    }
    return "delivered";
  }

  public async readVisible(paneId: string): Promise<HerdrVisibleState> {
    const result = await this.request("pane.read", {
      pane_id: paneId,
      source: "visible",
      format: "ansi",
      strip_ansi: false,
      lines: null,
    });
    if (!isRecord(result) || result.type !== "pane_read" || !isRecord(result.read)) {
      throw new HerdrTerminalError("protocol_error");
    }
    const read = result.read;
    if (
      read.pane_id !== paneId ||
      read.source !== "visible" ||
      read.format !== "ansi" ||
      typeof read.text !== "string" ||
      typeof read.truncated !== "boolean"
    ) {
      throw new HerdrTerminalError("protocol_error");
    }
    return { paneId, ansi: read.text, truncated: read.truncated };
  }

  public async attachPane(paneId: string, signal: AbortSignal): Promise<HerdrAttachment> {
    const socket = await this.openSocket(signal);
    const lines = new SocketLineIterator(socket, signal);
    const request = encodeRequest("pane.attach", { pane_id: paneId });
    socket.write(request.payload);
    let envelope: { id: string; result: unknown };
    try {
      const acknowledgement = await lines.next();
      if (acknowledgement.done) throw new HerdrTerminalError("transport_lost", true);
      envelope = parseEnvelope(acknowledgement.value);
      if (
        envelope.id !== request.id ||
        !isRecord(envelope.result) ||
        envelope.result.type !== "pane_attached" ||
        envelope.result.pane_id !== paneId
      ) {
        throw new HerdrTerminalError("protocol_error");
      }
    } catch (error) {
      lines.close();
      throw error;
    }
    return {
      stream: {
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<HerdrAttachChunk>> => {
            const line = await lines.next();
            if (line.done) return { done: true, value: undefined };
            const value = parseJson(line.value);
            if (
              !isRecord(value) ||
              value.id !== envelope.id ||
              value.stream !== true ||
              !isRecord(value.chunk)
            ) {
              throw new HerdrTerminalError("protocol_error");
            }
            const chunk = value.chunk;
            if (
              chunk.pane_id !== paneId ||
              !Number.isSafeInteger(chunk.seq) ||
              (chunk.seq as number) <= 0 ||
              chunk.encoding !== "base64" ||
              typeof chunk.data !== "string"
            ) {
              throw new HerdrTerminalError("protocol_error");
            }
            try {
              decodeTerminalBytes(chunk.data);
            } catch {
              throw new HerdrTerminalError("protocol_error");
            }
            return {
              done: false,
              value: { paneId, sequence: chunk.seq as number, data: chunk.data },
            };
          },
          return: async () => {
            lines.close();
            return { done: true, value: undefined };
          },
        }),
      },
      close: () => lines.close(),
    };
  }

  public async sendInput(paneId: string, text: string): Promise<void> {
    const result = await this.request("pane.send_input", { pane_id: paneId, text, keys: [] });
    if (!isRecord(result) || result.type !== "ok") throw new HerdrTerminalError("protocol_error");
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = await this.openSocket();
    const lines = new SocketLineIterator(socket);
    try {
      const request = encodeRequest(method, params);
      socket.write(request.payload);
      const response = await lines.next();
      if (response.done) throw new HerdrTerminalError("transport_lost", true);
      const envelope = parseEnvelope(response.value);
      if (envelope.id !== request.id) throw new HerdrTerminalError("protocol_error");
      return envelope.result;
    } finally {
      lines.close();
    }
  }

  private openSocket(signal?: AbortSignal): Promise<Socket> {
    if (signal?.aborted) return Promise.reject(new HerdrTerminalError("transport_lost", true));
    return new Promise((resolve, reject) => {
      const socket = this.connect(this.socketPath);
      const cleanup = (): void => {
        socket.removeListener("connect", onConnect);
        socket.removeListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      const onConnect = (): void => {
        cleanup();
        resolve(socket);
      };
      const onError = (): void => {
        cleanup();
        socket.destroy();
        reject(new HerdrTerminalError("transport_lost", true));
      };
      const onAbort = (): void => {
        cleanup();
        socket.destroy();
        reject(new HerdrTerminalError("transport_lost", true));
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function matchesAdoptedBinding(observation: AgentObservation, binding: AdoptedWorkerBinding): boolean {
  return (
    observation.adoptable &&
    observation.transport === binding.transport &&
    observation.transportInstanceId === binding.transportInstanceId &&
    observation.terminalId === binding.terminalId &&
    observation.harness === binding.harness &&
    observation.agentSessionId === binding.agentSessionId &&
    observation.workspace.workspaceId === binding.workspace.workspaceId &&
    observation.workspace.root === binding.workspace.root
  );
}

export interface HerdrTerminalProviderOptions {
  transport: HerdrTransport;
  columns?: number;
  rows?: number;
  maxSeedAttempts?: number;
  settleSeed?: () => Promise<void>;
  canControl?: (pane: Readonly<HerdrPaneSummary>) => boolean;
  leases?: ControlLeaseManager;
}

interface HerdrRecord {
  pane: HerdrPaneSummary;
  bridge: HerdrBridgeTransport;
  abort: AbortController;
  control: boolean;
  closed: boolean;
}

/** Runner-owned Herdr source adapter backed by the same ordered VT provider as native PTYs. */
export class HerdrTerminalProvider implements TerminalSourceProvider, TerminalProvider {
  private readonly transport: HerdrTransport;
  private readonly manager: TerminalManager;
  private readonly leases: ControlLeaseManager;
  private readonly records = new Map<string, HerdrRecord>();
  private readonly columns: number;
  private readonly rows: number;
  private readonly maxSeedAttempts: number;
  private readonly settleSeed: () => Promise<void>;
  private readonly canControl: (pane: Readonly<HerdrPaneSummary>) => boolean;

  public constructor(options: HerdrTerminalProviderOptions | string) {
    if (typeof options === "string")
      options = { transport: new HerdrSocketTransport({ socketPath: options }) };
    this.transport = options.transport;
    this.manager = new TerminalManager();
    this.leases = options.leases ?? new ControlLeaseManager();
    this.columns = positiveDimension(options.columns ?? DEFAULT_COLUMNS, "columns");
    this.rows = positiveDimension(options.rows ?? DEFAULT_ROWS, "rows");
    this.maxSeedAttempts = positiveDimension(
      options.maxSeedAttempts ?? DEFAULT_SEED_ATTEMPTS,
      "maxSeedAttempts",
    );
    this.settleSeed =
      options.settleSeed ?? (() => new Promise((resolve) => setTimeout(resolve, DEFAULT_SEED_QUIET_MS)));
    this.canControl = options.canControl ?? (() => false);
  }

  public async refresh(): Promise<void> {
    const panes = await this.transport.listPanes();
    const live = new Map(panes.map((pane) => [pane.terminalId, pane] as const));
    for (const [terminalId, record] of this.records) {
      const pane = live.get(terminalId);
      if (!pane || pane.paneId !== record.pane.paneId) {
        this.closeRecord(record, pane ? "transport_lost" : "terminated");
      }
    }
    for (const pane of panes) {
      const existing = this.records.get(pane.terminalId);
      if (existing && !existing.closed) continue;
      if (existing) {
        if (this.manager.observerCount(pane.terminalId) > 0) continue;
        await this.manager.whenIdle(pane.terminalId);
        this.manager.forgetClosedTerminal(pane.terminalId);
        this.records.delete(pane.terminalId);
      }
      this.startRecord(pane);
    }
  }

  public async listSessions(): Promise<TerminalSession[]> {
    await this.refresh();
    return this.manager.listSessions();
  }

  public openObservations(): TerminalObservation[] {
    return this.manager.openObservations();
  }

  public observation(terminalId: string): TerminalObservation {
    return this.manager.observation(terminalId);
  }

  public resumeDisposition(terminalId: string, fromSequence: number): TerminalResumeDisposition {
    return this.manager.resumeDisposition(terminalId, fromSequence);
  }

  public awaitSnapshotProjection(
    terminalId: string,
    minBoundary: number,
    signal: AbortSignal,
  ): Promise<
    | { status: "projected"; projection: TerminalSnapshotProjection }
    | { status: "unavailable" }
    | { status: "aborted" }
  > {
    return this.manager.awaitSnapshotProjection(terminalId, minBoundary, signal);
  }

  public observe(
    terminalId: string,
    fromSequence?: number,
    signal?: AbortSignal,
  ): AsyncIterable<TerminalFrame> {
    return this.manager.observe(terminalId, fromSequence, signal);
  }

  /** Deterministic adapter/test barrier after injected Herdr transport activity. */
  public whenIdle(terminalId: string): Promise<void> {
    return this.manager.whenIdle(terminalId);
  }

  public capabilities(terminalId: string): TerminalCapabilities {
    const record = this.mustRecord(terminalId);
    return {
      observe: true,
      resume: true,
      vtRestoreSnapshot: true,
      controlLease: record.control,
      input: record.control,
      resize: false,
    };
  }

  public capabilitiesRevision(terminalId: string): number {
    this.mustRecord(terminalId);
    return 1;
  }

  public async acquireControl(terminalId: string, principalId: string): Promise<ControlLease> {
    const record = this.mustRecord(terminalId);
    if (!record.control) throw new HerdrTerminalError("control_unavailable");
    if (record.closed) throw new HerdrTerminalError("not_found");
    return this.leases.acquire(terminalId, principalId);
  }

  public renewControl(terminalId: string, leaseId: string, durationMs = 60_000): ControlLease {
    this.mustRecord(terminalId);
    return this.leases.renew(terminalId, leaseId, durationMs);
  }

  public async sendInput(terminalId: string, leaseId: string, bytes: Uint8Array): Promise<void> {
    const record = this.mustRecord(terminalId);
    if (!record.control) throw new HerdrTerminalError("control_unavailable");
    this.leases.assert(terminalId, leaseId);
    if (record.closed) throw new HerdrTerminalError("not_found");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new HerdrTerminalError("invalid_input");
    }
    await this.transport.sendInput(record.pane.paneId, text);
  }

  public async resize(
    _terminalId?: string,
    _leaseId?: string,
    _columns?: number,
    _rows?: number,
  ): Promise<void> {
    throw new HerdrTerminalError("control_unavailable");
  }

  public async releaseControl(terminalId: string, leaseId: string): Promise<void> {
    this.mustRecord(terminalId);
    this.leases.release(terminalId, leaseId);
  }

  private startRecord(pane: HerdrPaneSummary): void {
    assertPublicTerminalId(pane.terminalId);
    const bridge = new HerdrBridgeTransport();
    const abort = new AbortController();
    const record: HerdrRecord = {
      pane: { ...pane, title: safeTitle(pane.title, pane.paneId) },
      bridge,
      abort,
      control: this.canControl(pane),
      closed: false,
    };
    this.records.set(pane.terminalId, record);
    this.manager.spawnTerminal({
      id: pane.terminalId,
      workerRunId: `herdr:${createHash("sha256").update(pane.terminalId).digest("hex").slice(0, 24)}`,
      title: safeTitle(pane.title, pane.paneId),
      command: "herdr-pane",
      transport: bridge,
      provider: "herdr",
      source: "herdr",
      columns: this.columns,
      rows: this.rows,
    });
    void this.runRecord(record).catch((error: unknown) => {
      if (!record.closed && !record.abort.signal.aborted) {
        this.closeRecord(
          record,
          error instanceof HerdrTerminalError && error.code === "sequence_discontinuity"
            ? "sequence_discontinuity"
            : "transport_lost",
        );
      }
    });
  }

  private async runRecord(record: HerdrRecord): Promise<void> {
    const attachment = await this.transport.attachPane(record.pane.paneId, record.abort.signal);
    const buffered: HerdrAttachChunk[] = [];
    let lastAttachSequence = 0;
    let live = false;
    let pumpError: unknown;
    const pump = (async () => {
      try {
        for await (const chunk of attachment.stream) {
          if (chunk.sequence !== lastAttachSequence + 1) {
            throw new HerdrTerminalError("sequence_discontinuity", true);
          }
          lastAttachSequence = chunk.sequence;
          if (live) record.bridge.emit(decodeTerminalBytes(chunk.data));
          else buffered.push(chunk);
        }
      } catch (error) {
        pumpError = error;
      }
    })();

    try {
      let seed: HerdrVisibleState | undefined;
      let seamSequence = 0;
      for (let attempt = 0; attempt < this.maxSeedAttempts; attempt += 1) {
        const before = lastAttachSequence;
        const first = await this.transport.readVisible(record.pane.paneId);
        const second = await this.transport.readVisible(record.pane.paneId);
        await this.settleSeed();
        if (pumpError) throw pumpError;
        if (
          !first.truncated &&
          !second.truncated &&
          first.ansi === second.ansi &&
          lastAttachSequence === before
        ) {
          seed = second;
          seamSequence = lastAttachSequence;
          break;
        }
      }
      if (!seed) throw new HerdrTerminalError("seed_unstable", true);
      if (seed.ansi.length > 0) record.bridge.emit(Buffer.from(seed.ansi, "utf8"));
      for (const chunk of buffered) {
        if (chunk.sequence > seamSequence) record.bridge.emit(decodeTerminalBytes(chunk.data));
      }
      buffered.length = 0;
      live = true;
      await pump;
      if (pumpError) throw pumpError;
      if (!record.abort.signal.aborted) throw new HerdrTerminalError("transport_lost", true);
    } finally {
      attachment.close();
    }
  }

  private closeRecord(record: HerdrRecord, reason: TerminalClosure["reason"]): void {
    if (record.closed) return;
    record.closed = true;
    record.abort.abort();
    this.leases.revoke(record.pane.terminalId);
    record.bridge.close(reason);
  }

  private mustRecord(terminalId: string): HerdrRecord {
    const record = this.records.get(terminalId);
    if (!record) throw new HerdrTerminalError("not_found");
    return record;
  }
}

class HerdrBridgeTransport implements TerminalTransport {
  private dataListener: ((chunk: Buffer) => void) | undefined;
  private exitListener:
    | ((exitCode: number | null, signal?: string, reason?: TerminalClosure["reason"]) => void)
    | undefined;
  private closed = false;

  public write(): void {
    throw new HerdrTerminalError("control_unavailable");
  }
  public resize(): void {
    throw new HerdrTerminalError("control_unavailable");
  }
  public kill(): void {
    this.close("terminated");
  }
  public onData(listener: (chunk: Buffer) => void): void {
    this.dataListener = listener;
  }
  public onExit(
    listener: (exitCode: number | null, signal?: string, reason?: TerminalClosure["reason"]) => void,
  ): void {
    this.exitListener = listener;
  }
  public emit(bytes: Uint8Array): void {
    if (!this.closed && bytes.byteLength > 0) this.dataListener?.(Buffer.from(bytes));
  }
  public close(reason: TerminalClosure["reason"]): void {
    if (this.closed) return;
    this.closed = true;
    this.exitListener?.(null, undefined, reason);
  }
}

class SocketLineIterator implements AsyncIterator<string> {
  private readonly socket: Socket;
  private readonly signal: AbortSignal | undefined;
  private readonly lines: string[] = [];
  private readonly waiters: Array<() => void> = [];
  private buffer = Buffer.alloc(0);
  private ended = false;
  private failure: HerdrTerminalError | undefined;

  public constructor(socket: Socket, signal?: AbortSignal) {
    this.socket = socket;
    this.signal = signal;
    socket.on("data", this.onData);
    socket.once("end", this.onEnd);
    socket.once("close", this.onEnd);
    socket.once("error", this.onError);
    signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  public async next(): Promise<IteratorResult<string>> {
    for (;;) {
      const line = this.lines.shift();
      if (line !== undefined) return { done: false, value: line };
      if (this.failure) throw this.failure;
      if (this.ended) return { done: true, value: undefined };
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  public close(): void {
    if (this.ended) return;
    this.ended = true;
    this.cleanup();
    this.socket.destroy();
    this.wake();
  }

  private readonly onData = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.byteLength > MAX_HERDR_LINE_BYTES) {
      this.failure = new HerdrTerminalError("protocol_error");
      this.close();
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.buffer.subarray(0, newline).toString("utf8");
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length > 0) this.lines.push(line);
    }
    this.wake();
  };

  private readonly onEnd = (): void => {
    this.ended = true;
    this.cleanup();
    this.wake();
  };

  private readonly onError = (): void => {
    this.failure = new HerdrTerminalError("transport_lost", true);
    this.onEnd();
  };

  private readonly onAbort = (): void => this.close();

  private wake(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  private cleanup(): void {
    this.socket.removeListener("data", this.onData);
    this.socket.removeListener("end", this.onEnd);
    this.socket.removeListener("close", this.onEnd);
    this.socket.removeListener("error", this.onError);
    this.signal?.removeEventListener("abort", this.onAbort);
  }
}

function encodeRequest(method: string, params: Record<string, unknown>): { id: string; payload: string } {
  const id = `clankie-${randomUUID()}`;
  return { id, payload: `${JSON.stringify({ id, method, params })}\n` };
}

function parseEnvelope(line: string): { id: string; result: unknown } {
  const value = parseJson(line);
  if (!isRecord(value) || typeof value.id !== "string") throw new HerdrTerminalError("protocol_error");
  if (isRecord(value.error)) {
    const code =
      value.error.code === "pane_not_found" || value.error.code === "not_found"
        ? "not_found"
        : "protocol_error";
    throw new HerdrTerminalError(code);
  }
  if (!("result" in value)) throw new HerdrTerminalError("protocol_error");
  return { id: value.id, result: value.result };
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new HerdrTerminalError("protocol_error");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new HerdrTerminalError("protocol_error");
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Herdr agent labels the runner can map onto a harness; anything else is not an agent. */
const HERDR_HARNESS_BY_AGENT: Readonly<Record<string, Harness>> = {
  claude: "claude",
  codex: "codex",
  pi: "pi",
};

const HERDR_STATUS_BY_AGENT_STATUS: Readonly<Record<string, AgentReportedStatus>> = {
  working: "working",
  idle: "idle",
  done: "done",
  blocked: "blocked",
};

/**
 * Pure `pane.list` record → census observation. Exported so the mapping can be
 * frozen by tests without a socket.
 *
 * A pane is `adoptable` only when Herdr reports a workspace, a known harness,
 * and a native session id: a bare shell is reportable but can never be steered
 * (ADR 0078). An unrecognized `agent_status` degrades to `unknown`
 * rather than being dropped, because the pane's existence is the fact that
 * matters and its status is only a Tier-2 hint.
 */
export function herdrPaneToAgentObservation(
  value: unknown,
  identity: { transportInstanceId?: string; workspaceRoot?: string } = {},
): AgentObservation | undefined {
  if (!isRecord(value)) return undefined;
  const terminalId = optionalString(value.terminal_id);
  const workspaceId = optionalString(value.workspace_id);
  if (terminalId === undefined || workspaceId === undefined || identity.workspaceRoot === undefined) {
    return undefined;
  }
  const paneId = optionalString(value.pane_id);
  const rawTitle =
    optionalString(value.terminal_title_stripped) ?? optionalString(value.terminal_title) ?? "Herdr pane";
  const harness = readHerdrHarness(value.agent);
  const agentSessionId = readHerdrAgentSessionId(value.agent_session);
  const adoptable = harness !== undefined && agentSessionId !== undefined;
  const cwd = optionalString(value.cwd);
  const status = optionalString(value.agent_status);
  const observation: AgentObservation = {
    transport: "herdr",
    transportInstanceId: identity.transportInstanceId ?? "default",
    terminalId,
    workspace: {
      workspaceId,
      root: identity.workspaceRoot,
    },
    label: safeTitle(rawTitle, paneId),
    reportedStatus: (status === undefined ? undefined : HERDR_STATUS_BY_AGENT_STATUS[status]) ?? "unknown",
    adoptable,
    ...(harness === undefined ? {} : { harness }),
    ...(agentSessionId === undefined ? {} : { agentSessionId }),
    ...(cwd === undefined ? {} : { cwd: cwd.slice(0, 1024) }),
  };
  const parsed = AgentObservationSchema.safeParse(observation);
  return parsed.success ? parsed.data : undefined;
}

function readHerdrHarness(value: unknown): Harness | undefined {
  const agent = optionalString(value);
  return agent === undefined ? undefined : HERDR_HARNESS_BY_AGENT[agent];
}

/**
 * Only an `id`-kind session is a durable binding key. Herdr also reports
 * inferred session shapes; binding to one would silently re-point the adoption
 * the moment the inference changed.
 */
function readHerdrAgentSessionId(value: unknown): string | undefined {
  if (!isRecord(value) || value.kind !== "id") return undefined;
  return optionalString(value.value);
}

function safeTitle(value: string, privatePaneId?: string): string {
  const title = [...value]
    .map((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 256);
  if (
    (privatePaneId !== undefined && title.includes(privatePaneId)) ||
    /(?:^|\s)(?:~\/|\/[^\s])/u.test(title) ||
    /\b(?:herdr|pane|session|socket|sock(?:et)?[_ -]?path)(?:[_ -]?id)?\s*[:=]/iu.test(title) ||
    /\b(?:pane|session)[-_:][A-Za-z0-9._:-]+\b/iu.test(title)
  ) {
    return "Herdr pane";
  }
  return title || "Herdr pane";
}

export async function canonicalWorkspaceRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    const root = stdout.trim();
    return resolve(root || cwd);
  } catch {
    return resolve(cwd);
  }
}

function assertPublicTerminalId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new HerdrTerminalError("protocol_error");
  }
}

function positiveDimension(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1_000) {
    throw new Error(`${name} must be a positive integer at most 1000`);
  }
  return value;
}
