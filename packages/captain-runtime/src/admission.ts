import type { CaptainLane } from "@clankie/protocol";
import type { CaptainRuntimeEventSink } from "./types.ts";

export interface CaptainAdmissionControllerOptions {
  readonly capacity: number;
  readonly tuiReservation?: number;
  readonly maxQueuedPerLane?: number;
  readonly clock?: () => Date;
  readonly events?: CaptainRuntimeEventSink;
}

export interface CaptainAdmissionRequest {
  readonly requestId: string;
  readonly laneKey: string;
  readonly lane: CaptainLane;
  readonly signal?: AbortSignal;
}

export interface CaptainAdmissionLease {
  readonly requestId: string;
  readonly laneKey: string;
  readonly lane: CaptainLane;
  readonly signal: AbortSignal;
  readonly borrowedForegroundCapacity: boolean;
  release(reason?: string): void;
  park(reason: string): void;
}

interface PendingAdmission extends CaptainAdmissionRequest {
  readonly sequence: number;
  readonly resolve: (lease: CaptainAdmissionLease) => void;
  readonly reject: (error: Error) => void;
  removeAbortListener?: () => void;
}

interface ActiveAdmission {
  readonly request: PendingAdmission;
  readonly controller: AbortController;
  readonly borrowedForegroundCapacity: boolean;
  settled: boolean;
}

const PRIORITY: Readonly<Record<CaptainLane, number>> = {
  tui: 300,
  discord_voice: 200,
  discord_presence: 200,
  gameplay: 100,
};

export class CaptainAdmissionQueueFullError extends Error {
  public constructor(laneKey: string) {
    super(`Captain lane ${laneKey} reached its bounded admission queue`);
    this.name = "CaptainAdmissionQueueFullError";
  }
}

export class CaptainAdmissionPreemptedError extends Error {
  public constructor(requestId: string, foregroundRequestId: string) {
    super(`Gameplay request ${requestId} was preempted for foreground request ${foregroundRequestId}`);
    this.name = "CaptainAdmissionPreemptedError";
  }
}

export class CaptainProviderPressureError extends Error {
  public constructor(message = "Provider rejected the admitted model call") {
    super(message);
    this.name = "CaptainProviderPressureError";
  }
}

export class CaptainAdmissionController {
  private readonly capacity: number;
  private readonly tuiReservation: number;
  private readonly maxQueuedPerLane: number;
  private readonly clock: () => Date;
  private readonly eventSink: CaptainRuntimeEventSink;
  private readonly pending: PendingAdmission[] = [];
  private readonly active = new Map<string, ActiveAdmission>();
  private readonly activeLanes = new Set<string>();
  private sequence = 0;

  public constructor(options: CaptainAdmissionControllerOptions) {
    this.capacity = positiveInteger(options.capacity, "Provider capacity");
    this.tuiReservation = nonnegativeInteger(options.tuiReservation ?? 1, "TUI reservation");
    this.maxQueuedPerLane = positiveInteger(options.maxQueuedPerLane ?? 8, "Per-lane queue limit");
    if (this.tuiReservation > this.capacity) {
      throw new Error("TUI reservation cannot exceed provider capacity");
    }
    this.clock = options.clock ?? (() => new Date());
    this.eventSink = options.events ?? (() => undefined);
  }

  public acquire(request: CaptainAdmissionRequest): Promise<CaptainAdmissionLease> {
    validateRequest(request);
    if (this.hasRequest(request.requestId)) {
      return Promise.reject(new Error(`Duplicate captain admission request ${request.requestId}`));
    }
    if (
      this.pending.filter((candidate) => candidate.laneKey === request.laneKey).length >=
      this.maxQueuedPerLane
    ) {
      return Promise.reject(new CaptainAdmissionQueueFullError(request.laneKey));
    }
    if (request.signal?.aborted === true) {
      return Promise.reject(abortError(request.signal.reason));
    }
    return new Promise<CaptainAdmissionLease>((resolve, reject) => {
      const pending: PendingAdmission = {
        ...request,
        sequence: this.sequence++,
        resolve,
        reject,
      };
      if (request.signal !== undefined) {
        const abort = () => this.abortRequest(pending, request.signal?.reason);
        request.signal.addEventListener("abort", abort, { once: true });
        pending.removeAbortListener = () => request.signal?.removeEventListener("abort", abort);
      }
      this.pending.push(pending);
      this.emit("admission.queued", pending);
      this.preemptForForeground();
      this.schedule();
    });
  }

  public async execute<T>(
    request: CaptainAdmissionRequest,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const lease = await this.acquire(request);
    try {
      return await run(lease.signal);
    } catch (error) {
      if (error instanceof CaptainProviderPressureError) lease.park(error.message);
      throw error;
    } finally {
      lease.release();
    }
  }

  public snapshot(): {
    readonly active: readonly string[];
    readonly queued: readonly string[];
  } {
    return {
      active: [...this.active.keys()],
      queued: this.sortedPending().map((request) => request.requestId),
    };
  }

  private schedule(): void {
    while (this.active.size < this.capacity) {
      const foregroundWaiting = this.pending.some((request) => request.lane !== "gameplay");
      const candidate = this.sortedPending().find(
        (request) =>
          !this.activeLanes.has(request.laneKey) && !(request.lane === "gameplay" && foregroundWaiting),
      );
      if (candidate === undefined) return;
      const index = this.pending.indexOf(candidate);
      if (index < 0) return;
      this.pending.splice(index, 1);
      const borrowedForegroundCapacity =
        candidate.lane === "gameplay" && this.active.size >= this.capacity - this.tuiReservation;
      const active: ActiveAdmission = {
        request: candidate,
        controller: new AbortController(),
        borrowedForegroundCapacity,
        settled: false,
      };
      this.active.set(candidate.requestId, active);
      this.activeLanes.add(candidate.laneKey);
      this.emit(
        "admission.admitted",
        candidate,
        borrowedForegroundCapacity ? "borrowed_foreground_reservation" : undefined,
      );
      candidate.resolve(this.lease(active));
    }
  }

  private preemptForForeground(): void {
    const foreground = this.sortedPending().find((request) => request.lane !== "gameplay");
    if (foreground === undefined || this.active.size < this.capacity) return;
    const gameplay = [...this.active.values()]
      .filter((admission) => admission.request.lane === "gameplay" && !admission.controller.signal.aborted)
      .sort((left, right) => {
        if (left.borrowedForegroundCapacity !== right.borrowedForegroundCapacity) {
          return left.borrowedForegroundCapacity ? -1 : 1;
        }
        return right.request.sequence - left.request.sequence;
      })[0];
    if (gameplay === undefined) return;
    const reason = new CaptainAdmissionPreemptedError(gameplay.request.requestId, foreground.requestId);
    this.emit("admission.preempt_requested", gameplay.request, `foreground:${foreground.requestId}`);
    gameplay.controller.abort(reason);
  }

  private lease(active: ActiveAdmission): CaptainAdmissionLease {
    const finish = (type: "release" | "park", reason?: string): void => {
      if (active.settled) return;
      active.settled = true;
      active.request.removeAbortListener?.();
      this.active.delete(active.request.requestId);
      this.activeLanes.delete(active.request.laneKey);
      this.emit(type === "park" ? "admission.parked" : "admission.released", active.request, reason);
      this.preemptForForeground();
      this.schedule();
    };
    return {
      requestId: active.request.requestId,
      laneKey: active.request.laneKey,
      lane: active.request.lane,
      signal: active.controller.signal,
      borrowedForegroundCapacity: active.borrowedForegroundCapacity,
      release: (reason) => finish("release", reason),
      park: (reason) => finish("park", reason),
    };
  }

  private abortRequest(request: PendingAdmission, reason: unknown): void {
    const pendingIndex = this.pending.indexOf(request);
    if (pendingIndex >= 0) {
      this.pending.splice(pendingIndex, 1);
      request.removeAbortListener?.();
      request.reject(abortError(reason));
      this.emit("admission.released", request, "aborted_before_admission");
      this.schedule();
      return;
    }
    const active = this.active.get(request.requestId);
    if (active !== undefined && !active.controller.signal.aborted) active.controller.abort(reason);
  }

  private hasRequest(requestId: string): boolean {
    return this.active.has(requestId) || this.pending.some((request) => request.requestId === requestId);
  }

  private sortedPending(): PendingAdmission[] {
    return [...this.pending].sort(
      (left, right) => PRIORITY[right.lane] - PRIORITY[left.lane] || left.sequence - right.sequence,
    );
  }

  private emit(
    type:
      | "admission.queued"
      | "admission.admitted"
      | "admission.preempt_requested"
      | "admission.parked"
      | "admission.released",
    request: PendingAdmission,
    reason?: string,
  ): void {
    void Promise.resolve(
      this.eventSink({
        type,
        occurredAt: this.clock().toISOString(),
        laneKey: request.laneKey,
        lane: request.lane,
        requestId: request.requestId,
        queueSequence: request.sequence,
        ...(reason === undefined ? {} : { reason }),
      }),
    ).catch(() => undefined);
  }
}

function validateRequest(request: CaptainAdmissionRequest): void {
  if (request.requestId.length === 0 || request.laneKey.length === 0) {
    throw new Error("Captain admission request and lane keys are required");
  }
  if (!(request.lane in PRIORITY)) throw new Error(`Unknown captain lane ${request.lane}`);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new DOMException("Captain admission aborted", "AbortError");
}
