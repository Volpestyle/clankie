import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { EventStore } from "@clankie/event-store";
import { createLogger } from "@clankie/observability";
import type { DomainEvent } from "@clankie/protocol";

const execFileAsync = promisify(execFile);
const logger = createLogger({ service: "clankie-runner-process-leases", version: "0.1.0" });

export type ProcessLeaseState = "live" | "cancelling" | "cancelled" | "expired" | "failed" | "completed";

/**
 * A lease over one worker process. Identity is pid + process start time so a
 * recycled pid can never masquerade as a live worker.
 */
export interface ProcessLease {
  id: string;
  missionId: string;
  taskId: string;
  workerRunId: string;
  profileHash: string;
  pid: number;
  /** Opaque process start-time token captured at registration. */
  processStartedAt: string;
  /** Runner process that currently owns (has adopted) this lease. */
  runnerPid: number;
  state: ProcessLeaseState;
  registeredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface RegisterLeaseInput {
  missionId: string;
  taskId: string;
  workerRunId: string;
  profileHash: string;
  pid: number;
}

export interface ReconcileProcessReport {
  readopted: ProcessLease[];
  failed: ProcessLease[];
  /** Leases already owned by this runner; nothing to do. */
  retained: ProcessLease[];
  /** Cancellations a previous runner died in the middle of, finished now. */
  resumedCancels: ProcessLease[];
  corruptRemoved: string[];
}

export interface ProcessLeaseManagerOptions {
  /** State root; lease records live under `<rootDir>/process-leases`. */
  rootDir: string;
  events: EventStore;
  /** Heartbeat validity window. */
  leaseDurationMs?: number;
  /** SIGTERM → SIGKILL grace during cancellation. */
  cancelGraceMs?: number;
  clock?: () => Date;
  /** Identity of this runner instance for lease adoption; defaults to process.pid. */
  runnerPid?: number;
  /** Injectable for tests; returns an identity token for a live pid, undefined when dead. */
  processIdentity?: (pid: number) => Promise<string | undefined>;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * Durable worker-process leases (docs/03 M1: crash the control plane while
 * workers run, reconnect, recover exact state without duplicate side effects).
 *
 * Every transition is appended to the event store — an expired heartbeat
 * becomes a recoverable `worker.lease.expired`, never a silent loss.
 * Transitions are guarded by the current state, so cancellation and restart
 * reconciliation are idempotent: repeating them cannot emit duplicate events
 * or signal a process twice.
 *
 * Invariant: exactly one runner instance owns a state root at a time.
 * Sequential ownership (crash → restart) is reconciled; two live runners
 * sharing a root would race lease adoption.
 */
export class ProcessLeaseManager {
  private readonly rootDir: string;
  private readonly events: EventStore;
  private readonly leaseDurationMs: number;
  private readonly cancelGraceMs: number;
  private readonly clock: () => Date;
  private readonly runnerPid: number;
  private readonly processIdentity: (pid: number) => Promise<string | undefined>;
  private readonly killProcess: (pid: number, signal: NodeJS.Signals) => void;
  private readonly activeCancels = new Map<string, Promise<ProcessLease>>();
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(options: ProcessLeaseManagerOptions) {
    this.rootDir = resolve(options.rootDir);
    this.events = options.events;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.cancelGraceMs = options.cancelGraceMs ?? 5_000;
    this.clock = options.clock ?? (() => new Date());
    this.runnerPid = options.runnerPid ?? process.pid;
    this.processIdentity = options.processIdentity ?? defaultProcessIdentity;
    this.killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  }

  public register(input: RegisterLeaseInput): Promise<ProcessLease> {
    return this.enqueue(async () => {
      const identity = await this.processIdentity(input.pid);
      if (identity === undefined) {
        throw new Error(`Cannot lease pid ${String(input.pid)}: process is not alive`);
      }
      const now = this.clock();
      const lease: ProcessLease = {
        id: randomUUID(),
        ...input,
        processStartedAt: identity,
        runnerPid: this.runnerPid,
        state: "live",
        registeredAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.leaseDurationMs).toISOString(),
      };
      await this.persist(lease);
      await this.record("worker.lease.registered", lease, { pid: lease.pid });
      return lease;
    });
  }

  /** Extend a live lease. Expired/terminal leases refuse the heartbeat loudly. */
  public heartbeat(leaseId: string): Promise<ProcessLease> {
    return this.enqueue(async () => {
      const lease = await this.mustRead(leaseId);
      await this.expireIfStale(lease);
      if (lease.state !== "live") {
        throw new Error(`Lease ${leaseId} is ${lease.state}; heartbeat refused`);
      }
      const now = this.clock();
      lease.heartbeatAt = now.toISOString();
      lease.expiresAt = new Date(now.getTime() + this.leaseDurationMs).toISOString();
      await this.persist(lease);
      return { ...lease };
    });
  }

  /** Transition every stale live lease to the recoverable `expired` state. */
  public expireStale(): Promise<ProcessLease[]> {
    return this.enqueue(async () => {
      const expired: ProcessLease[] = [];
      for (const lease of (await this.readAll()).leases) {
        if (lease.state === "live" && (await this.expireIfStale(lease))) expired.push(lease);
      }
      return expired;
    });
  }

  /**
   * Cooperative-then-hard cancellation. Idempotent: within one runner,
   * concurrent cancels share a single in-flight sequence (one event pair, one
   * signal set); a cancel that finds the lease terminal returns it unchanged.
   * A lease stuck in `cancelling` (runner crashed mid-cancel) is resumed —
   * the sequence finishes and `worker.cancelled` is still emitted. The grace
   * wait runs outside the serialized op queue so heartbeats are never starved.
   */
  public cancel(leaseId: string, reason: string): Promise<ProcessLease> {
    const active = this.activeCancels.get(leaseId);
    if (active) return active;
    const sequence = this.runCancel(leaseId, reason).finally(() => {
      this.activeCancels.delete(leaseId);
    });
    this.activeCancels.set(leaseId, sequence);
    return sequence;
  }

  private async runCancel(leaseId: string, reason: string): Promise<ProcessLease> {
    // Phase 1 (serialized): transition to cancelling and emit the request once.
    const lease = await this.enqueue(async () => {
      const current = await this.mustRead(leaseId);
      if (current.state === "cancelled" || current.state === "completed" || current.state === "failed") {
        return current;
      }
      if (current.state !== "cancelling") {
        current.state = "cancelling";
        await this.persist(current);
        await this.record("worker.cancel.requested", current, { reason });
      }
      return current;
    });
    if (lease.state !== "cancelling") return { ...lease };

    // Phase 2 (unserialized): SIGTERM, grace, SIGKILL — the queue stays free.
    const identity = await this.processIdentity(lease.pid);
    if (identity === lease.processStartedAt) {
      this.tryKill(lease.pid, "SIGTERM");
      const deadline = Date.now() + this.cancelGraceMs;
      while (Date.now() < deadline) {
        if ((await this.processIdentity(lease.pid)) !== lease.processStartedAt) break;
        await sleep(Math.min(50, this.cancelGraceMs));
      }
      if ((await this.processIdentity(lease.pid)) === lease.processStartedAt) {
        this.tryKill(lease.pid, "SIGKILL");
      }
    }

    // Phase 3 (serialized): finish the transition and emit completion once.
    return this.enqueue(async () => {
      let current: ProcessLease;
      try {
        current = await this.mustRead(leaseId);
      } catch {
        // The worker completed normally during the grace window and retired
        // its lease; terminate the cancel narrative in the log instead of
        // rejecting the caller.
        current = { ...lease, state: "completed" };
        await this.record("worker.cancel.superseded", current, { reason });
        return current;
      }
      if (current.state === "cancelling") {
        current.state = "cancelled";
        await this.persist(current);
        await this.record("worker.cancelled", current, { reason });
      }
      return { ...current };
    });
  }

  /** Normal completion: retire the lease without recovery semantics. Idempotent. */
  public complete(leaseId: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.mustRead(leaseId);
      } catch {
        return; // already retired
      }
      await unlink(this.leaseFile(leaseId)).catch(() => undefined);
    });
  }

  /**
   * Restart reconciliation: re-adopt leases whose process is still the same
   * live process (pid + start time), fail the rest explicitly, and resume any
   * cancellation a previous runner died in the middle of. Running it again is
   * a no-op — adoption is keyed on the owning runner pid.
   */
  public reconcile(): Promise<ReconcileProcessReport> {
    return this.enqueue(async () => {
      const report: ReconcileProcessReport = {
        readopted: [],
        failed: [],
        retained: [],
        resumedCancels: [],
        corruptRemoved: [],
      };
      const { leases, corrupt } = await this.readAll();
      for (const file of corrupt) {
        await unlink(file).catch(() => undefined);
        report.corruptRemoved.push(file);
        await this.events.append({
          id: randomUUID(),
          occurredAt: this.clock().toISOString(),
          missionId: "unknown",
          correlationId: file,
          profileHash: "unknown",
          type: "worker.lease.corrupt",
          data: { file },
        });
        logger.error({ file }, "corrupt process lease removed during reconciliation");
      }
      const toResume: ProcessLease[] = [];
      for (const lease of leases) {
        if (lease.state !== "live" && lease.state !== "cancelling") continue;
        if (lease.state === "cancelling") {
          toResume.push(lease);
          continue;
        }
        if (lease.runnerPid === this.runnerPid) {
          report.retained.push(lease);
          continue;
        }
        const identity = await this.processIdentity(lease.pid);
        if (identity === lease.processStartedAt) {
          lease.runnerPid = this.runnerPid;
          await this.persist(lease);
          await this.record("worker.readopted", lease, { pid: lease.pid });
          report.readopted.push(lease);
        } else {
          lease.state = "failed";
          await this.persist(lease);
          await this.record("worker.lost", lease, {
            pid: lease.pid,
            observedIdentity: identity ?? null,
          });
          report.failed.push(lease);
        }
      }
      logger.info(
        {
          readopted: report.readopted.length,
          failed: report.failed.length,
          retained: report.retained.length,
          resuming: toResume.length,
          corruptRemoved: report.corruptRemoved.length,
        },
        "process lease reconciliation complete",
      );
      return { report, toResume };
    }).then(async ({ report, toResume }) => {
      // Resume interrupted cancellations outside the serialized section: a
      // lease must never be stranded in `cancelling` with its worker running.
      for (const lease of toResume) {
        const finished = await this.cancel(lease.id, "resumed after runner restart");
        report.resumedCancels.push(finished);
      }
      return report;
    });
  }

  public list(): Promise<ProcessLease[]> {
    return this.enqueue(async () => (await this.readAll()).leases);
  }

  private async expireIfStale(lease: ProcessLease): Promise<boolean> {
    if (lease.state !== "live") return false;
    if (Date.parse(lease.expiresAt) > this.clock().getTime()) return false;
    lease.state = "expired";
    await this.persist(lease);
    await this.record("worker.lease.expired", lease, {
      heartbeatAt: lease.heartbeatAt,
      expiresAt: lease.expiresAt,
    });
    return true;
  }

  private async record(type: string, lease: ProcessLease, data: Record<string, unknown>): Promise<void> {
    const event: DomainEvent = {
      id: randomUUID(),
      occurredAt: this.clock().toISOString(),
      missionId: lease.missionId,
      taskId: lease.taskId,
      workerRunId: lease.workerRunId,
      correlationId: lease.workerRunId,
      profileHash: lease.profileHash,
      type,
      data: { leaseId: lease.id, ...data },
    };
    await this.events.append(event);
  }

  private tryKill(pid: number, signal: NodeJS.Signals): void {
    try {
      this.killProcess(pid, signal);
    } catch (error) {
      logger.warn({ pid, signal, err: String(error) }, "signal delivery failed");
    }
  }

  private async persist(lease: ProcessLease): Promise<void> {
    await mkdir(join(this.rootDir, "process-leases"), { recursive: true });
    // Atomic write: a crash mid-persist must never tear a live worker's record.
    // The random suffix keeps concurrent writers from colliding on the tmp name.
    const target = this.leaseFile(lease.id);
    const temporary = `${target}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  private async mustRead(leaseId: string): Promise<ProcessLease> {
    try {
      return JSON.parse(await readFile(this.leaseFile(leaseId), "utf8")) as ProcessLease;
    } catch {
      throw new Error(`Unknown process lease ${leaseId}`);
    }
  }

  private async readAll(): Promise<{ leases: ProcessLease[]; corrupt: string[] }> {
    let files: string[];
    try {
      files = await readdir(join(this.rootDir, "process-leases"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { leases: [], corrupt: [] };
      throw error;
    }
    const leases: ProcessLease[] = [];
    const corrupt: string[] = [];
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const path = join(this.rootDir, "process-leases", file);
      try {
        leases.push(JSON.parse(await readFile(path, "utf8")) as ProcessLease);
      } catch {
        corrupt.push(path);
      }
    }
    return { leases, corrupt };
  }

  private leaseFile(leaseId: string): string {
    return join(this.rootDir, "process-leases", `${leaseId}.json`);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/** Pid + start time defeats pid reuse: `ps` start time changes with the process. */
async function defaultProcessIdentity(pid: number): Promise<string | undefined> {
  try {
    const result = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
    const startedAt = result.stdout.trim();
    return startedAt.length > 0 ? startedAt : undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
