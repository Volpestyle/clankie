import { randomUUID } from "node:crypto";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import { createLogger } from "@clankie/observability";
import {
  encodeTerminalBytes,
  type TerminalCapabilities,
  type ControlLease,
  type TerminalFrame,
  type TerminalProvider,
  type TerminalSession,
} from "@clankie/terminal-protocol";
import { spawn, type IPty } from "node-pty";
import { ControlLeaseManager } from "./control-leases.ts";

const logger = createLogger({ service: "clankie-runner-terminals", version: "0.1.0" });

export interface TerminalTransport {
  write(bytes: Uint8Array): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (chunk: Buffer) => void): void;
  onExit(
    listener: (exitCode: number | null, signal?: string, reason?: TerminalClosure["reason"]) => void,
  ): void;
}

export interface TerminalAttemptContext {
  missionId: string;
  taskId: string;
  workerRunId: string;
  attempt: number;
  provider: string;
  source: "runner_pty" | "herdr";
  nativeSessionId?: string;
}

export interface SpawnTerminalOptions {
  id?: string;
  workerRunId: string;
  title: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  columns?: number;
  rows?: number;
  transport?: TerminalTransport;
  provider?: TerminalSession["provider"];
  source?: TerminalAttemptContext["source"];
  context?: Omit<TerminalAttemptContext, "workerRunId" | "source">;
}

export interface TerminalManagerOptions {
  maxBufferedBytes?: number;
  /** Deprecated compatibility option; VT snapshots are complete and never byte-truncated. */
  maxSnapshotBytes?: number;
  maxObserverQueueFrames?: number;
  maxBufferedFrames?: number;
  leases?: ControlLeaseManager;
  onHumanControlChanged?: (workerRunId: string, active: boolean) => void;
}

/** Authoritative closure identity retained independently of replay eviction. */
export interface TerminalClosure {
  sequence: number;
  reason: "exited" | "signaled" | "transport_lost" | "terminated" | "sequence_discontinuity";
  exitCode: number | null;
  signal: null;
  closedAt: string;
}

/** Atomic read-only manager state used by the terminal wire gateway. */
export interface TerminalObservation {
  terminalId: string;
  workerRunId: string;
  title: string;
  source: TerminalAttemptContext["source"];
  columns: number;
  rows: number;
  lastSequence: number;
  retainedFromSequence: number;
  snapshot: { sequence: number; data: string; columns: number; rows: number };
  closure: TerminalClosure | null;
}

/** Current serialized VT state at one parser-quiescent sequence boundary. */
export interface TerminalSnapshotProjection {
  sequence: number;
  data: string;
  columns: number;
  rows: number;
  closure: TerminalClosure | null;
}

export type TerminalResumeDisposition = "replay" | "live" | "unavailable";

interface BufferedFrame {
  frame: TerminalFrame;
  bytes: number;
}
interface Observer {
  queue: TerminalFrame[];
  wake: (() => void) | undefined;
  done: boolean;
  resync: boolean;
  replayNextSequence: number | undefined;
  aborted: boolean;
}
interface TerminalRecord {
  session: TerminalSession;
  context: TerminalAttemptContext;
  transport: TerminalTransport;
  emulator: Terminal;
  serializer: SerializeAddon;
  frames: BufferedFrame[];
  bufferedBytes: number;
  observers: Set<Observer>;
  closed: boolean;
  pipeline: Promise<void>;
  humanControl: boolean;
  parserBoundary: ParserBoundary;
  snapshot: { sequence: number; data: string; columns: number; rows: number };
  closure: TerminalClosure | null;
  snapshotWaiters: Set<() => void>;
}

class ParserBoundary {
  private utf8 = 0;
  private escape: "ground" | "esc" | "csi" | "osc" | "osc_esc" | "dcs" | "dcs_esc" = "ground";
  public feed(bytes: Uint8Array): void {
    for (const byte of bytes) {
      if (this.utf8 > 0) {
        if ((byte & 0xc0) === 0x80) this.utf8 -= 1;
        else {
          this.utf8 = 0;
          this.feed(Uint8Array.of(byte));
        }
        continue;
      }
      if (byte >= 0xc2 && byte <= 0xdf) {
        this.utf8 = 1;
        continue;
      }
      if (byte >= 0xe0 && byte <= 0xef) {
        this.utf8 = 2;
        continue;
      }
      if (byte >= 0xf0 && byte <= 0xf4) {
        this.utf8 = 3;
        continue;
      }
      if (this.escape === "ground") {
        if (byte === 0x1b) this.escape = "esc";
        continue;
      }
      if (byte === 0x18 || byte === 0x1a || byte === 0x9c) {
        this.escape = "ground";
        continue;
      }
      if (this.escape === "esc") {
        if (byte === 0x5b) this.escape = "csi";
        else if (byte === 0x5d) this.escape = "osc";
        else if (byte === 0x50) this.escape = "dcs";
        else if (byte < 0x20 || byte > 0x2f) this.escape = "ground";
        continue;
      }
      if (this.escape === "csi") {
        if (byte >= 0x40 && byte <= 0x7e) this.escape = "ground";
        continue;
      }
      if (this.escape === "osc" || this.escape === "dcs") {
        if (byte === 0x07 && this.escape === "osc") this.escape = "ground";
        else if (byte === 0x1b) this.escape = this.escape === "osc" ? "osc_esc" : "dcs_esc";
        continue;
      }
      if (this.escape === "osc_esc" || this.escape === "dcs_esc") {
        if (byte === 0x5c) this.escape = "ground";
        else this.escape = this.escape === "osc_esc" ? "osc" : "dcs";
      }
    }
  }
  public get quiescent(): boolean {
    return this.utf8 === 0 && this.escape === "ground";
  }
}

/** Runner-authoritative ownership of native PTYs, ordered VT state, replay and control. */
export class TerminalManager implements TerminalProvider {
  private readonly terminals = new Map<string, TerminalRecord>();
  private readonly leases: ControlLeaseManager;
  private readonly maxBufferedBytes: number;
  private readonly maxObserverQueueFrames: number;
  private readonly maxBufferedFrames: number;
  private readonly onHumanControlChanged?: TerminalManagerOptions["onHumanControlChanged"];

  public constructor(options: TerminalManagerOptions = {}) {
    this.leases = options.leases ?? new ControlLeaseManager();
    this.maxBufferedBytes = options.maxBufferedBytes ?? 512 * 1024;
    this.maxObserverQueueFrames = options.maxObserverQueueFrames ?? 1024;
    this.maxBufferedFrames = options.maxBufferedFrames ?? 8192;
    this.onHumanControlChanged = options.onHumanControlChanged;
  }

  public spawnTerminal(options: SpawnTerminalOptions): TerminalSession {
    const id = options.id ?? `term-${randomUUID().slice(0, 12)}`;
    if (!id || this.terminals.has(id))
      throw new Error(!id ? "Terminal id must not be empty" : `Terminal ${id} already exists`);
    const columns = options.columns ?? 120;
    const rows = options.rows ?? 40;
    const transport =
      options.transport ??
      spawnNativePtyTransport(options.command, options.args ?? [], {
        cwd: options.cwd ?? process.cwd(),
        columns,
        rows,
        ...(options.env ? { env: options.env } : {}),
      });
    const emulator = new Terminal({ cols: columns, rows, allowProposedApi: true });
    const serializer = new SerializeAddon();
    emulator.loadAddon(serializer);
    const session: TerminalSession = {
      id,
      workerRunId: options.workerRunId,
      provider: options.provider ?? "native_pty",
      title: options.title,
      columns,
      rows,
      lastSequence: 0,
    };
    const record: TerminalRecord = {
      session,
      context: {
        missionId: options.context?.missionId ?? "local",
        taskId: options.context?.taskId ?? "local",
        workerRunId: options.workerRunId,
        attempt: options.context?.attempt ?? 1,
        provider: options.context?.provider ?? String(session.provider),
        source: options.source ?? "runner_pty",
        ...(options.context?.nativeSessionId ? { nativeSessionId: options.context.nativeSessionId } : {}),
      },
      transport,
      emulator,
      serializer,
      frames: [],
      bufferedBytes: 0,
      observers: new Set(),
      closed: false,
      pipeline: Promise.resolve(),
      humanControl: false,
      parserBoundary: new ParserBoundary(),
      snapshot: {
        sequence: 0,
        data: Buffer.from("\u001bc").toString("base64"),
        columns,
        rows,
      },
      closure: null,
      snapshotWaiters: new Set(),
    };
    this.terminals.set(id, record);
    transport.onData((chunk) => {
      record.pipeline = record.pipeline.then(() => this.appendOutput(record, chunk));
    });
    transport.onExit((exitCode, signal, reason) => {
      record.pipeline = record.pipeline.then(() => this.appendClosed(record, exitCode, signal, reason));
    });
    logger.info(
      { terminalId: id, workerRunId: options.workerRunId, source: options.source ?? "runner_pty" },
      "terminal spawned",
    );
    return { ...session };
  }

  public bindNativeSession(workerRunId: string, attempt: number, nativeSessionId: string): void {
    for (const record of this.terminals.values())
      if (record.context.workerRunId === workerRunId && record.context.attempt === attempt && !record.closed)
        record.context.nativeSessionId = nativeSessionId;
  }

  public context(terminalId: string): Readonly<TerminalAttemptContext> {
    return structuredClone(this.mustGet(terminalId).context);
  }
  public whenIdle(terminalId: string): Promise<void> {
    return this.mustGet(terminalId).pipeline;
  }
  public hasHumanControl(workerRunId: string): boolean {
    this.expireLeases();
    return [...this.terminals.values()].some(
      (r) => r.context.workerRunId === workerRunId && r.humanControl && !r.closed,
    );
  }
  public listSessions(): Promise<TerminalSession[]> {
    return Promise.resolve(
      [...this.terminals.values()].filter((r) => !r.closed).map((r) => ({ ...r.session })),
    );
  }

  public refresh(): Promise<void> {
    return Promise.resolve();
  }

  public capabilities(terminalId: string): TerminalCapabilities {
    this.mustGet(terminalId);
    return {
      observe: true,
      resume: true,
      vtRestoreSnapshot: true,
      controlLease: true,
      input: true,
      resize: true,
    };
  }

  public capabilitiesRevision(terminalId: string): number {
    this.mustGet(terminalId);
    return 1;
  }

  public observation(terminalId: string): TerminalObservation {
    return this.observeState(this.mustGet(terminalId));
  }

  public openObservations(): TerminalObservation[] {
    return [...this.terminals.values()]
      .filter((record) => !record.closed)
      .map((record) => this.observeState(record));
  }

  public resumeDisposition(terminalId: string, fromSequence: number): TerminalResumeDisposition {
    const record = this.mustGet(terminalId);
    if (!this.isResumable(record, fromSequence)) return "unavailable";
    return record.frames.some(({ frame }) => frame.sequence > fromSequence) ? "replay" : "live";
  }

  /** Number of live observers, exposed to prove attachment teardown deterministically. */
  public observerCount(terminalId: string): number {
    return this.mustGet(terminalId).observers.size;
  }

  /**
   * Await a current VT projection at a quiescent boundary at or beyond the
   * requested floor. This never mutates the accepted VUH-868 replay snapshot.
   */
  public async awaitSnapshotProjection(
    terminalId: string,
    minBoundary: number,
    signal: AbortSignal,
  ): Promise<
    | { status: "projected"; projection: TerminalSnapshotProjection }
    | { status: "unavailable" }
    | { status: "aborted" }
  > {
    const record = this.mustGet(terminalId);
    if (minBoundary > record.session.lastSequence) return { status: "unavailable" };
    for (;;) {
      if (signal.aborted) return { status: "aborted" };
      if (record.session.lastSequence >= minBoundary) {
        const projected = await this.projectConsistently(record, signal);
        if (projected === "aborted") return { status: "aborted" };
        if (projected !== "waiting") return { status: "projected", projection: projected };
      }
      if (record.closed) return { status: "unavailable" };
      const sequence = record.session.lastSequence;
      const woke = await this.waitForSnapshotStateChange(record, sequence, minBoundary, signal);
      if (woke === "aborted") return { status: "aborted" };
    }
  }

  private async projectConsistently(
    record: TerminalRecord,
    signal: AbortSignal,
  ): Promise<TerminalSnapshotProjection | "waiting" | "aborted"> {
    let result: TerminalSnapshotProjection | "waiting" = "waiting";
    const task = record.pipeline.then(() => {
      result = record.parserBoundary.quiescent ? this.projectNow(record) : "waiting";
    });
    record.pipeline = task;
    if (signal.aborted) return "aborted";
    const outcome = await new Promise<"done" | "aborted">((resolve) => {
      const onAbort = (): void => {
        cleanup();
        resolve("aborted");
      };
      const cleanup = (): void => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
      void task.then(() => {
        cleanup();
        resolve("done");
      });
      if (signal.aborted) onAbort();
    });
    return outcome === "aborted" ? "aborted" : result;
  }

  private projectNow(record: TerminalRecord): TerminalSnapshotProjection {
    return {
      sequence: record.session.lastSequence,
      data: Buffer.from(record.serializer.serialize() || "\u001bc").toString("base64"),
      columns: record.session.columns,
      rows: record.session.rows,
      closure: record.closure ? { ...record.closure } : null,
    };
  }

  /** Register then recheck so an append between observation and registration cannot be missed. */
  private waitForSnapshotStateChange(
    record: TerminalRecord,
    observedSequence: number,
    minBoundary: number,
    signal: AbortSignal,
  ): Promise<"woke" | "aborted"> {
    return new Promise((resolve) => {
      let settled = false;
      const cleanup = (): void => {
        record.snapshotWaiters.delete(wake);
        signal.removeEventListener("abort", onAbort);
      };
      const finish = (outcome: "woke" | "aborted"): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(outcome);
      };
      const wake = (): void => finish("woke");
      const onAbort = (): void => finish("aborted");
      if (signal.aborted) {
        finish("aborted");
        return;
      }
      record.snapshotWaiters.add(wake);
      signal.addEventListener("abort", onAbort, { once: true });
      if (
        signal.aborted ||
        record.closed ||
        record.session.lastSequence !== observedSequence ||
        (record.session.lastSequence >= minBoundary && record.parserBoundary.quiescent)
      ) {
        queueMicrotask(signal.aborted ? onAbort : wake);
      }
    });
  }

  private wakeSnapshotWaiters(record: TerminalRecord): void {
    for (const wake of record.snapshotWaiters) wake();
  }

  private observeState(record: TerminalRecord): TerminalObservation {
    return {
      terminalId: record.session.id,
      workerRunId: record.session.workerRunId,
      title: record.session.title,
      source: record.context.source,
      columns: record.session.columns,
      rows: record.session.rows,
      lastSequence: record.session.lastSequence,
      retainedFromSequence: record.frames[0]?.frame.sequence ?? record.session.lastSequence + 1,
      snapshot: { ...record.snapshot },
      closure: record.closure ? { ...record.closure } : null,
    };
  }

  public async *observe(
    terminalId: string,
    fromSequence?: number,
    signal?: AbortSignal,
  ): AsyncIterable<TerminalFrame> {
    const record = this.mustGet(terminalId);
    const observer: Observer = {
      queue: [],
      wake: undefined,
      done: record.closed,
      resync: false,
      replayNextSequence: undefined,
      aborted: signal?.aborted ?? false,
    };
    const onAbort = (): void => {
      observer.aborted = true;
      observer.wake?.();
      observer.wake = undefined;
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    record.observers.add(observer);
    let horizon = fromSequence ?? -1;
    try {
      if (fromSequence === undefined || !this.isResumable(record, fromSequence)) {
        horizon = this.beginSnapshotReplay(record, observer);
      } else observer.replayNextSequence = fromSequence + 1;
      while (true) {
        if (observer.aborted) break;
        if (observer.resync) {
          observer.resync = false;
          observer.queue.length = 0;
          horizon = this.beginSnapshotReplay(record, observer);
        }
        this.refillObserver(record, observer);
        const frame = observer.queue.shift();
        if (!frame) {
          if (observer.done || observer.replayNextSequence !== undefined) break;
          await new Promise<void>((resolve) => {
            observer.wake = resolve;
            if (observer.aborted) {
              observer.wake = undefined;
              resolve();
            }
          });
          continue;
        }
        if (frame.type !== "snapshot" && frame.sequence <= horizon) continue;
        horizon = frame.sequence;
        yield frame;
        if (frame.type === "closed") break;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      observer.wake = undefined;
      record.observers.delete(observer);
    }
  }

  private beginSnapshotReplay(record: TerminalRecord, observer: Observer): number {
    const snapshot = this.snapshotFrame(record);
    observer.queue.push(snapshot);
    observer.replayNextSequence = snapshot.sequence + 1;
    return snapshot.sequence - 1;
  }

  private refillObserver(record: TerminalRecord, observer: Observer): void {
    while (observer.replayNextSequence !== undefined && observer.queue.length < this.maxObserverQueueFrames) {
      const nextSequence = observer.replayNextSequence;
      if (nextSequence > record.session.lastSequence) {
        observer.replayNextSequence = undefined;
        return;
      }
      const firstRetainedSequence = record.frames[0]?.frame.sequence;
      if (firstRetainedSequence === undefined || firstRetainedSequence > nextSequence) {
        observer.replayNextSequence = undefined;
        observer.done = true;
        return;
      }
      const item = record.frames.find(({ frame }) => frame.sequence === nextSequence);
      if (!item) {
        observer.replayNextSequence = undefined;
        observer.done = true;
        return;
      }
      observer.queue.push(item.frame);
      observer.replayNextSequence = nextSequence + 1;
    }
  }

  public async acquireControl(terminalId: string, principalId: string): Promise<ControlLease> {
    const record = this.mustGet(terminalId);
    if (record.closed) throw new Error(`Terminal ${terminalId} is closed`);
    const lease = this.leases.acquire(terminalId, principalId);
    this.setHumanControl(record, true);
    return lease;
  }
  public renewControl(terminalId: string, leaseId: string, durationMs = 60_000): ControlLease {
    return this.leases.renew(terminalId, leaseId, durationMs);
  }
  public async sendInput(terminalId: string, leaseId: string, bytes: Uint8Array): Promise<void> {
    const r = this.mustGet(terminalId);
    this.assertControlLease(terminalId, leaseId);
    if (r.closed) throw new Error(`Terminal ${terminalId} is closed`);
    r.transport.write(bytes);
  }
  public async resize(terminalId: string, leaseId: string, columns: number, rows: number): Promise<void> {
    const r = this.mustGet(terminalId);
    this.assertControlLease(terminalId, leaseId);
    if (r.closed) throw new Error(`Terminal ${terminalId} is closed`);
    if (r.frames.length >= this.maxBufferedFrames && r.parserBoundary.quiescent) this.captureSnapshot(r);
    r.transport.resize(columns, rows);
    r.emulator.resize(columns, rows);
    r.session.columns = columns;
    r.session.rows = rows;
    this.appendFrame(r, (sequence) => ({ type: "resized", terminalId, sequence, columns, rows }), 0);
  }
  public async releaseControl(terminalId: string, leaseId: string): Promise<void> {
    const r = this.mustGet(terminalId);
    this.leases.release(terminalId, leaseId);
    this.setHumanControl(r, false);
  }
  public cancel(terminalId: string): void {
    const r = this.mustGet(terminalId);
    r.transport.kill("SIGTERM");
  }
  public kill(terminalId: string): void {
    this.mustGet(terminalId).transport.kill("SIGKILL");
  }
  public closeOrphanedRecords(): string[] {
    const ids: string[] = [];
    for (const [id, r] of this.terminals)
      if (!r.closed) {
        ids.push(id);
        void this.appendClosed(r, null, undefined, "terminated");
      }
    return ids;
  }

  /** Reuse a stable external identity only after its prior generation fully drained. */
  public forgetClosedTerminal(terminalId: string): void {
    const record = this.mustGet(terminalId);
    if (!record.closed || record.observers.size > 0) {
      throw new Error(`Terminal ${terminalId} is not a drained closed record`);
    }
    this.terminals.delete(terminalId);
  }

  private async appendOutput(record: TerminalRecord, chunk: Buffer): Promise<void> {
    if (record.closed || chunk.length === 0) return;
    record.parserBoundary.feed(chunk);
    await new Promise<void>((resolve) => record.emulator.write(chunk, resolve));
    this.appendFrame(
      record,
      (sequence) => ({
        type: "output",
        terminalId: record.session.id,
        sequence,
        encoding: "base64",
        data: encodeTerminalBytes(chunk),
      }),
      chunk.byteLength,
    );
    if (record.parserBoundary.quiescent) this.captureSnapshot(record);
  }
  private async appendClosed(
    record: TerminalRecord,
    exitCode: number | null,
    _signal?: string,
    reason?: TerminalClosure["reason"],
  ): Promise<void> {
    if (record.closed) return;
    record.closed = true;
    this.leases.revoke(record.session.id);
    this.setHumanControl(record, false);
    this.appendFrame(
      record,
      (sequence) => ({ type: "closed", terminalId: record.session.id, sequence, exitCode }),
      0,
    );
    record.closure = {
      sequence: record.session.lastSequence,
      reason: reason ?? (exitCode === null ? "terminated" : "exited"),
      exitCode,
      signal: null,
      closedAt: new Date().toISOString(),
    };
    for (const o of record.observers) {
      o.done = true;
      o.wake?.();
      o.wake = undefined;
    }
    this.wakeSnapshotWaiters(record);
  }
  private appendFrame(
    record: TerminalRecord,
    build: (sequence: number) => TerminalFrame,
    bytes: number,
  ): void {
    const frame = build(++record.session.lastSequence);
    record.frames.push({ frame, bytes });
    record.bufferedBytes += bytes;
    while (record.bufferedBytes > this.maxBufferedBytes || record.frames.length > this.maxBufferedFrames) {
      const old = record.frames.shift();
      if (!old) break;
      record.bufferedBytes -= old.bytes;
    }
    for (const o of record.observers) {
      if (o.replayNextSequence === undefined && !o.resync) {
        if (o.queue.length >= this.maxObserverQueueFrames) {
          o.queue.length = 0;
          o.resync = true;
        } else o.queue.push(frame);
      }
      o.wake?.();
      o.wake = undefined;
    }
    this.wakeSnapshotWaiters(record);
  }
  private snapshotFrame(record: TerminalRecord): TerminalFrame {
    return {
      type: "snapshot",
      terminalId: record.session.id,
      sequence: record.snapshot.sequence,
      encoding: "base64",
      data: record.snapshot.data,
      columns: record.snapshot.columns,
      rows: record.snapshot.rows,
    };
  }
  private captureSnapshot(record: TerminalRecord): void {
    record.snapshot = {
      sequence: record.session.lastSequence,
      data: Buffer.from(record.serializer.serialize() || "\u001bc").toString("base64"),
      columns: record.session.columns,
      rows: record.session.rows,
    };
  }
  private isResumable(record: TerminalRecord, sequence: number): boolean {
    return (
      sequence <= record.session.lastSequence &&
      (record.frames[0]?.frame.sequence ?? record.session.lastSequence + 1) <= sequence + 1
    );
  }
  private mustGet(id: string): TerminalRecord {
    const r = this.terminals.get(id);
    if (!r) throw new Error(`Unknown terminal ${id}`);
    return r;
  }
  private assertControlLease(terminalId: string, leaseId: string): ControlLease {
    const lease = this.leases.assert(terminalId, leaseId);
    if (lease.mode !== "control") throw new Error("An observe-only lease is not a valid control lease");
    return lease;
  }
  private setHumanControl(record: TerminalRecord, active: boolean): void {
    if (record.humanControl === active) return;
    record.humanControl = active;
    this.onHumanControlChanged?.(record.context.workerRunId, active);
  }
  private expireLeases(): void {
    for (const r of this.terminals.values())
      if (r.humanControl && !this.leases.active(r.session.id)) this.setHumanControl(r, false);
  }
}

export function spawnNativePtyTransport(
  command: string,
  args: string[],
  options: { cwd: string; columns: number; rows: number; env?: NodeJS.ProcessEnv },
): TerminalTransport {
  const env = Object.fromEntries(
    Object.entries(options.env ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  env.TERM = "xterm-256color";
  const pty: IPty = spawn(command, args, {
    name: "xterm-256color",
    cols: options.columns,
    rows: options.rows,
    cwd: options.cwd,
    env,
    encoding: null,
  });
  return {
    write: (bytes) => pty.write(Buffer.from(bytes)),
    resize: (columns, rows) => pty.resize(columns, rows),
    kill: (signal = "SIGKILL") => pty.kill(signal),
    onData: (listener) => {
      pty.onData((data) => listener(Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8")));
    },
    onExit: (listener) => {
      pty.onExit(({ exitCode, signal }) => listener(exitCode, signal ? String(signal) : undefined));
    },
  };
}
