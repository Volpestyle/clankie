import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { z } from "zod";

const Envelope = z
  .object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    ok: z.boolean(),
    result: z.unknown(),
    stderr: z.string().max(65_536),
  })
  .strict();
export type NativeTransportReason =
  | "queue_full"
  | "cancelled"
  | "timeout"
  | "helper_unavailable"
  | "protocol_invalid";
export interface NativeReply {
  stdout: string;
  stderr: string;
}
interface Job {
  id: number;
  owner: NativeProcessTransport;
  args: readonly string[];
  resolve(value: NativeReply | undefined): void;
  report?(reason: NativeTransportReason): void;
  timer?: ReturnType<typeof setTimeout>;
  cancelled?: true;
  signal?: AbortSignal;
  abort(): void;
}

function transportDiagnostic(report: Job["report"], reason: NativeTransportReason) {
  try {
    void Promise.resolve(report?.(reason)).catch(() => {});
  } catch {
    /* Diagnostics never grant authority. */
  }
}

/** Private pipes to one owned helper. Every job still performs a complete fresh kernel proof. */
class NativeProcessTransport {
  private child: ChildProcessWithoutNullStreams | undefined;
  private queue: Job[] = [];
  private active: Job | undefined;
  private sequence = 0;
  private output = Buffer.alloc(0);
  private failed = false;
  private closed: Promise<void> = Promise.resolve();
  private readonly helper: string;
  /** A successor spawns only after its timed-out predecessor's child has closed. */
  private readonly predecessor: Promise<void> | undefined;
  private waiting = false;
  constructor(helper: string, predecessor?: { closed: Promise<void>; sequence: number; queue: Job[] }) {
    this.helper = helper;
    if (!predecessor) return;
    this.sequence = predecessor.sequence;
    for (const job of predecessor.queue) job.owner = this;
    this.queue = predecessor.queue;
    this.predecessor = predecessor.closed;
    this.waiting = true;
    void predecessor.closed.then(() => {
      this.waiting = false;
      this.start();
    });
  }

  request(
    args: readonly string[],
    signal?: AbortSignal,
    report?: Job["report"],
  ): Promise<NativeReply | undefined> {
    if (signal?.aborted) {
      transportDiagnostic(report, "cancelled");
      return Promise.resolve(undefined);
    }
    if (this.failed) {
      transportDiagnostic(report, this.failureReason);
      return Promise.resolve(undefined);
    }
    if (this.queue.length >= 128) {
      transportDiagnostic(report, "queue_full");
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      const job: Job = {
        id: ++this.sequence,
        owner: this,
        args,
        resolve,
        ...(report ? { report } : {}),
        ...(signal ? { signal } : {}),
        abort: () => job.owner.cancel(job),
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      this.queue.push(job);
      this.start();
    });
  }

  private cancel(job: Job) {
    if (this.active === job) {
      // Keep the serial frame and proof permit until completion. A caller's
      // cancellation cannot kill another caller's independently queued proof.
      job.cancelled = true;
    } else {
      this.queue = this.queue.filter((entry) => entry !== job);
      this.finish(job, undefined, "cancelled");
    }
  }

  private finish(job: Job, reply?: NativeReply, reason?: NativeTransportReason) {
    clearTimeout(job.timer);
    job.signal?.removeEventListener("abort", job.abort);
    if (job.cancelled) {
      transportDiagnostic(job.report, "cancelled");
      job.resolve(undefined);
    } else {
      if (reason) transportDiagnostic(job.report, reason);
      job.resolve(reply);
    }
  }

  private start() {
    if (this.failed || this.waiting || this.active || this.queue.length === 0) return;
    if (!this.child) {
      const child = spawn(this.helper, ["--serve"], { stdio: "pipe" });
      this.child = child;
      // The body owns shutdown; this helper must not keep a finished CLI/test alive.
      child.unref();
      for (const stream of [child.stdin, child.stdout, child.stderr])
        (stream as typeof stream & { unref?(): void }).unref?.();
      this.closed = new Promise((resolve) => {
        child.once("close", () => {
          this.failed = true;
          if (transports.get(this.helper) === this) transports.delete(this.helper);
          if (this.active) this.finish(this.active, undefined, this.failureReason);
          for (const job of this.queue) this.finish(job, undefined, this.failureReason);
          this.active = undefined;
          this.queue = [];
          this.output = Buffer.alloc(0);
          resolve();
        });
      });
      child.on("error", () => this.stop("helper_unavailable"));
      child.stdin.on("error", () => this.stop("helper_unavailable"));
      child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
      // All successful protocol diagnostics are inside the bounded response envelope.
      child.stderr.on("data", () => this.stop("protocol_invalid"));
    }
    this.active = this.queue.shift();
    if (!this.active) return;
    // Queue time is not kernel-proof time; a burst must not kill unrelated jobs.
    this.active.timer = setTimeout(() => this.timeout(), 1_000);
    this.child.stdin.write(`${this.active.id} ${this.active.args.join(" ")}\n`);
  }

  private receive(chunk: Buffer) {
    if (this.failed) return;
    this.output = Buffer.concat([this.output, chunk]);
    if (this.output.length > 1_048_576) return this.stop("protocol_invalid");
    const newline = this.output.indexOf(10);
    if (newline < 0) return;
    // Serial transport permits exactly one complete reply, with no unsolicited bytes.
    if (!this.active || newline !== this.output.length - 1) return this.stop("protocol_invalid");
    try {
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(this.output.subarray(0, newline)),
      );
      const envelope = Envelope.parse(value);
      if (envelope.id !== this.active.id || (!envelope.ok && envelope.result !== null))
        return this.stop("protocol_invalid");
      const job = this.active;
      this.output = Buffer.alloc(0);
      this.active = undefined;
      this.finish(job, {
        stdout: envelope.ok ? JSON.stringify(envelope.result) : "",
        stderr: envelope.stderr,
      });
      this.start();
    } catch {
      this.stop("protocol_invalid");
    }
  }

  /**
   * One slow proof fails alone (VUH-2015). Its helper may still be mid-scan and
   * cannot be trusted with another serial frame, so it is killed; queued jobs that
   * were never dispatched move, unreplayed, to a fresh helper spawned after the old
   * one closes, and new callers reach that successor instead of a refusal.
   */
  private timeout() {
    if (this.failed) return;
    const successor = new NativeProcessTransport(this.helper, {
      closed: this.closed,
      sequence: this.sequence,
      queue: this.queue,
    });
    this.queue = [];
    if (transports.get(this.helper) === this) transports.set(this.helper, successor);
    this.stop("timeout");
  }

  private failureReason: NativeTransportReason = "helper_unavailable";
  private stop(reason: NativeTransportReason) {
    if (this.failed) return;
    this.failed = true;
    this.failureReason = reason;
    // Wait for close before releasing any in-flight proof/roster permit.
    this.child?.ref();
    if (this.child)
      for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr])
        (stream as typeof stream & { ref?(): void }).ref?.();
    this.child?.kill("SIGKILL");
    if (!this.child) {
      for (const job of this.queue) this.finish(job, undefined, reason);
      this.queue = [];
      if (transports.get(this.helper) === this) transports.delete(this.helper);
    }
  }
  async close() {
    this.stop("cancelled");
    await Promise.all([this.closed, this.predecessor]);
  }
}

const transports = new Map<string, NativeProcessTransport>();
export function nativeProcessRequest(
  helper: string,
  args: readonly string[],
  signal?: AbortSignal,
  report?: Job["report"],
): Promise<NativeReply | undefined> {
  if (
    !isAbsolute(helper) ||
    args.length === 0 ||
    args.length > 9 ||
    args.some((arg) => !/^[\x21-\x7e]+$/u.test(arg)) ||
    args.join(" ").length > 4_000
  ) {
    transportDiagnostic(report, "protocol_invalid");
    return Promise.resolve(undefined);
  }
  let transport = transports.get(helper);
  if (!transport) {
    transport = new NativeProcessTransport(helper);
    transports.set(helper, transport);
  }
  return transport.request(args, signal, report);
}

/** Shutdown only helpers owned by this body, after all pending observations settle. */
export async function closeNativeProcessObservers(): Promise<void> {
  await Promise.all([...transports.values()].map((transport) => transport.close()));
}
