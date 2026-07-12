import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createLogger } from "@clankie/observability";
import {
  encodeTerminalBytes,
  type ControlLease,
  type TerminalFrame,
  type TerminalProvider,
  type TerminalSession,
} from "@clankie/terminal-protocol";
import { ControlLeaseManager } from "./control-leases.ts";

const logger = createLogger({ service: "clankie-runner-terminals", version: "0.1.0" });

/**
 * Process transport behind the terminal manager. The pipe transport below is
 * always available; a native PTY implementation (node-pty) plugs in behind the
 * same interface without changing sequencing, replay, or lease semantics.
 */
export interface TerminalTransport {
  write(bytes: Uint8Array): void;
  resize(columns: number, rows: number): void;
  kill(): void;
  onData(listener: (chunk: Buffer) => void): void;
  onExit(listener: (exitCode: number | null) => void): void;
}

export interface SpawnTerminalOptions {
  /** Stable session identity when restoring a durable terminal after runner restart. */
  id?: string;
  workerRunId: string;
  title: string;
  command: string;
  args?: string[];
  cwd?: string;
  columns?: number;
  rows?: number;
  transport?: TerminalTransport;
  /** Session label for clients; defaults to "generic" (the pipe transport has no TTY semantics). */
  provider?: TerminalSession["provider"];
}

export interface TerminalManagerOptions {
  /** Ring-buffer budget for replayable frames, per terminal. */
  maxBufferedBytes?: number;
  /** Rolling snapshot tail size, per terminal. */
  maxSnapshotBytes?: number;
  /** Per-observer pending-frame budget before it is resynced from a snapshot. */
  maxObserverQueueFrames?: number;
  /** Frame-count cap for the replay buffer (bounds zero-byte frame floods). */
  maxBufferedFrames?: number;
  leases?: ControlLeaseManager;
}

interface BufferedFrame {
  frame: TerminalFrame;
  bytes: number;
}

interface Observer {
  queue: TerminalFrame[];
  wake: (() => void) | undefined;
  done: boolean;
}

interface TerminalRecord {
  session: TerminalSession;
  transport: TerminalTransport;
  frames: BufferedFrame[];
  bufferedBytes: number;
  snapshotTail: Buffer;
  /** Sequence covered by the snapshot: every byte at or before it is folded into snapshotTail. */
  snapshotSequence: number;
  observers: Set<Observer>;
  closed: boolean;
}

/**
 * Terminal manager for worker processes (docs/05 "Terminal protocol").
 *
 * Every frame carries a monotonically increasing per-terminal sequence.
 * Output that falls out of the bounded replay buffer is folded into a rolling
 * byte-tail snapshot, so `snapshot + buffered frames` is always a gap-free
 * suffix of the stream. Reconnecting clients resume from their last sequence
 * when it is still buffered and are otherwise resynced from the snapshot —
 * never with duplicated or missing buffered bytes. Input and resize require a
 * live control lease; observation does not (observe vs control at the
 * protocol layer).
 */
export class TerminalManager implements TerminalProvider {
  private readonly terminals = new Map<string, TerminalRecord>();
  private readonly leases: ControlLeaseManager;
  private readonly maxBufferedBytes: number;
  private readonly maxSnapshotBytes: number;
  private readonly maxObserverQueueFrames: number;
  private readonly maxBufferedFrames: number;

  public constructor(options: TerminalManagerOptions = {}) {
    this.leases = options.leases ?? new ControlLeaseManager();
    this.maxBufferedBytes = options.maxBufferedBytes ?? 512 * 1024;
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? 256 * 1024;
    this.maxObserverQueueFrames = options.maxObserverQueueFrames ?? 1024;
    this.maxBufferedFrames = options.maxBufferedFrames ?? 8192;
  }

  public spawnTerminal(options: SpawnTerminalOptions): TerminalSession {
    const id = options.id ?? `term-${randomUUID().slice(0, 12)}`;
    if (id.length === 0) throw new Error("Terminal id must not be empty");
    if (this.terminals.has(id)) throw new Error(`Terminal ${id} already exists`);
    const transport =
      options.transport ??
      spawnPipeTransport(options.command, options.args ?? [], options.cwd ?? process.cwd());
    const session: TerminalSession = {
      id,
      workerRunId: options.workerRunId,
      provider: options.provider ?? "generic",
      title: options.title,
      columns: options.columns ?? 120,
      rows: options.rows ?? 40,
      lastSequence: 0,
    };
    const record: TerminalRecord = {
      session,
      transport,
      frames: [],
      bufferedBytes: 0,
      snapshotTail: Buffer.alloc(0),
      snapshotSequence: 0,
      observers: new Set(),
      closed: false,
    };
    this.terminals.set(id, record);
    transport.onData((chunk) => this.appendOutput(record, chunk));
    transport.onExit((exitCode) => this.appendClosed(record, exitCode));
    logger.info(
      { terminalId: id, workerRunId: options.workerRunId, command: options.command },
      "terminal spawned",
    );
    return { ...session };
  }

  public listSessions(): Promise<TerminalSession[]> {
    return Promise.resolve([...this.terminals.values()].map((record) => ({ ...record.session })));
  }

  public async *observe(terminalId: string, fromSequence?: number): AsyncIterable<TerminalFrame> {
    const record = this.mustGet(terminalId);
    const observer: Observer = { queue: [], wake: undefined, done: record.closed };
    record.observers.add(observer);
    try {
      // Seed the backlog into the queue synchronously — no suspension between
      // reading the terminal state and registering for live frames, so a
      // reconnecting client can never observe a gap. Live frames appended
      // during iteration land behind the backlog and are deduped via horizon.
      let horizon: number;
      if (fromSequence !== undefined && this.isResumable(record, fromSequence)) {
        horizon = fromSequence;
      } else {
        observer.queue.push(this.snapshotFrame(record));
        horizon = record.snapshotSequence;
      }
      for (const buffered of record.frames) {
        if (buffered.frame.sequence > horizon) observer.queue.push(buffered.frame);
      }
      while (true) {
        const frame = observer.queue.shift();
        if (!frame) {
          if (observer.done) break;
          await new Promise<void>((resolvePromise) => {
            observer.wake = resolvePromise;
          });
          continue;
        }
        if (frame.type !== "snapshot" && frame.sequence <= horizon) continue;
        horizon = frame.sequence;
        yield frame;
        if (frame.type === "closed") break;
      }
    } finally {
      record.observers.delete(observer);
    }
  }

  public async acquireControl(terminalId: string, principalId: string): Promise<ControlLease> {
    this.mustGet(terminalId);
    return this.leases.acquire(terminalId, principalId);
  }

  public async sendInput(terminalId: string, leaseId: string, bytes: Uint8Array): Promise<void> {
    const record = this.mustGet(terminalId);
    const lease = this.leases.assert(terminalId, leaseId);
    if (lease.mode !== "control") {
      throw new Error(`Lease ${leaseId} is ${lease.mode}-only; input requires a control lease`);
    }
    if (record.closed) throw new Error(`Terminal ${terminalId} is closed`);
    record.transport.write(bytes);
  }

  public async resize(terminalId: string, leaseId: string, columns: number, rows: number): Promise<void> {
    const record = this.mustGet(terminalId);
    const lease = this.leases.assert(terminalId, leaseId);
    if (lease.mode !== "control") {
      throw new Error(`Lease ${leaseId} is ${lease.mode}-only; resize requires a control lease`);
    }
    if (record.closed) throw new Error(`Terminal ${terminalId} is closed`);
    record.transport.resize(columns, rows);
    record.session.columns = columns;
    record.session.rows = rows;
    this.appendFrame(
      record,
      (sequence) => ({ type: "resized", terminalId: record.session.id, sequence, columns, rows }),
      0,
    );
  }

  public async releaseControl(terminalId: string, leaseId: string): Promise<void> {
    this.mustGet(terminalId);
    this.leases.release(terminalId, leaseId);
  }

  public kill(terminalId: string): void {
    this.mustGet(terminalId).transport.kill();
  }

  private appendOutput(record: TerminalRecord, chunk: Buffer): void {
    if (record.closed) {
      // Bytes sequenced after "closed" would be undeliverable (observers end
      // at the closed frame); drop them loudly instead.
      logger.warn(
        { terminalId: record.session.id, droppedBytes: chunk.byteLength },
        "output after terminal close dropped",
      );
      return;
    }
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
  }

  private appendClosed(record: TerminalRecord, exitCode: number | null): void {
    if (record.closed) return;
    record.closed = true;
    this.appendFrame(
      record,
      (sequence) => ({ type: "closed", terminalId: record.session.id, sequence, exitCode }),
      0,
    );
    for (const observer of record.observers) {
      observer.done = true;
      observer.wake?.();
      observer.wake = undefined;
    }
  }

  private appendFrame(
    record: TerminalRecord,
    build: (sequence: number) => TerminalFrame,
    bytes: number,
  ): void {
    record.session.lastSequence += 1;
    const frame = build(record.session.lastSequence);
    record.frames.push({ frame, bytes });
    record.bufferedBytes += bytes;
    this.evict(record);
    for (const observer of record.observers) {
      if (observer.queue.length >= this.maxObserverQueueFrames) {
        // Backpressure: a lagging observer is resynced from a fresh snapshot
        // instead of buffering unbounded frames.
        observer.queue.length = 0;
        observer.queue.push(this.snapshotFrame(record));
        for (const buffered of record.frames) {
          if (buffered.frame.sequence > record.snapshotSequence) observer.queue.push(buffered.frame);
        }
      } else {
        observer.queue.push(frame);
      }
      observer.wake?.();
      observer.wake = undefined;
    }
  }

  private evict(record: TerminalRecord): void {
    while (
      (record.bufferedBytes > this.maxBufferedBytes || record.frames.length > this.maxBufferedFrames) &&
      record.frames.length > 0
    ) {
      const evicted = record.frames.shift() as BufferedFrame;
      record.bufferedBytes -= evicted.bytes;
      record.snapshotSequence = evicted.frame.sequence;
      if (evicted.frame.type === "output") {
        const bytes = Buffer.from(evicted.frame.data, "base64");
        record.snapshotTail = Buffer.concat([record.snapshotTail, bytes]);
        if (record.snapshotTail.byteLength > this.maxSnapshotBytes) {
          record.snapshotTail = record.snapshotTail.subarray(
            record.snapshotTail.byteLength - this.maxSnapshotBytes,
          );
        }
      }
    }
  }

  private snapshotFrame(record: TerminalRecord): TerminalFrame {
    return {
      type: "snapshot",
      terminalId: record.session.id,
      sequence: record.snapshotSequence,
      encoding: "base64",
      data: record.snapshotTail.toString("base64"),
      columns: record.session.columns,
      rows: record.session.rows,
    };
  }

  private isResumable(record: TerminalRecord, fromSequence: number): boolean {
    if (fromSequence > record.session.lastSequence) return false;
    return fromSequence >= record.snapshotSequence;
  }

  private mustGet(terminalId: string): TerminalRecord {
    const record = this.terminals.get(terminalId);
    if (!record) throw new Error(`Unknown terminal ${terminalId}`);
    return record;
  }
}

/** Pipe-based transport: stdout and stderr merged into one ordered stream. */
export function spawnPipeTransport(command: string, args: string[], cwd: string): TerminalTransport {
  const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  // Input can race process death before the exit event lands; an unhandled
  // stdin error event would otherwise take down the whole runner (EPIPE).
  child.stdin.on("error", () => undefined);
  return {
    write: (bytes) => {
      if (child.stdin.destroyed || !child.stdin.writable) {
        throw new Error("Terminal input channel is closed");
      }
      child.stdin.write(bytes, () => undefined);
    },
    resize: () => {
      // Pipes have no window size; the resized frame still reaches observers.
    },
    kill: () => {
      child.kill("SIGKILL");
    },
    onData: (listener) => {
      child.stdout.on("data", listener);
      child.stderr.on("data", listener);
    },
    onExit: (listener) => {
      child.on("exit", (code) => listener(code));
      child.on("error", () => listener(null));
    },
  };
}
