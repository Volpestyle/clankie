import {
  LinearWebhookEnvelopeSchema,
  type LinearWebhookEnvelope,
  type LinearWebhookEvidence,
  type LinearWebhookEvidenceSink,
  type LinearWebhookLeasedDelivery,
} from "./linear-webhook-protocol.ts";

export type LinearWebhookRetryReason = "bridge_disconnected" | "consumer_error";
export type LinearWebhookRejectReason = "bridge_verification_failed";

/** Opaque channel capability. Payload fields never participate in lease settlement. */
export type LinearWebhookLeaseReceipt = object;

export interface LinearWebhookReceivedDelivery {
  readonly receipt: LinearWebhookLeaseReceipt;
  readonly payload: unknown;
}

export interface LinearWebhookDeliveryChannel {
  receive(): Promise<LinearWebhookReceivedDelivery | null>;
  acknowledge(receipt: LinearWebhookLeaseReceipt): Promise<void>;
  retry(receipt: LinearWebhookLeaseReceipt, reason: "consumer_error"): Promise<"dead_lettered" | "scheduled">;
  reject(receipt: LinearWebhookLeaseReceipt, reason: LinearWebhookRejectReason): Promise<void>;
  close(): Promise<void>;
}

/** A local bridge calls dial; the hosted side never opens a connection to the local machine. */
export interface LinearWebhookOutboundTransport {
  dial(): Promise<LinearWebhookDeliveryChannel>;
}

export interface LinearWebhookQueueOptions {
  readonly capacity?: number;
  readonly retentionMs?: number;
  readonly retryDelaysMs?: readonly number[];
  readonly clock?: () => number;
  readonly evidence?: LinearWebhookEvidenceSink;
}

export type LinearWebhookEnqueueOutcome = "accepted" | "backpressure" | "duplicate" | "offline";

type QueueState = "delivered" | "failed" | "in_flight" | "pending" | "rejected";

interface QueueRecord {
  readonly envelope: LinearWebhookEnvelope;
  state: QueueState;
  attempts: number;
  availableAtMs: number;
  leaseId: string | null;
  leaseReceipt: LinearWebhookLeaseReceipt | null;
}

export interface LinearWebhookQueueSnapshot {
  readonly capacity: number;
  readonly connectedBridges: number;
  readonly queued: number;
  readonly inFlight: number;
  readonly delivered: number;
  readonly failed: number;
}

const noopEvidence: LinearWebhookEvidenceSink = () => undefined;

export class RetainedLinearWebhookQueue implements LinearWebhookOutboundTransport {
  public readonly capacity: number;
  public readonly retentionMs: number;

  private readonly retryDelaysMs: readonly number[];
  private readonly clock: () => number;
  private readonly evidence: LinearWebhookEvidenceSink;
  private readonly records = new Map<string, QueueRecord>();
  private readonly leasedRecords = new WeakMap<LinearWebhookLeaseReceipt, QueueRecord>();
  private readonly sessions = new Set<string>();
  private nextSession = 0;

  public constructor(options: LinearWebhookQueueOptions = {}) {
    this.capacity = options.capacity ?? 64;
    this.retentionMs = options.retentionMs ?? 55_000;
    this.retryDelaysMs = options.retryDelaysMs ?? [1_000, 5_000, 15_000];
    this.clock = options.clock ?? Date.now;
    this.evidence = options.evidence ?? noopEvidence;

    if (!Number.isInteger(this.capacity) || this.capacity < 1) {
      throw new Error("Linear webhook queue capacity must be a positive integer");
    }
    if (!Number.isInteger(this.retentionMs) || this.retentionMs < 1) {
      throw new Error("Linear webhook queue retention must be a positive integer");
    }
    if (
      this.retryDelaysMs.some((delay) => !Number.isInteger(delay) || delay < 0 || delay >= this.retentionMs)
    ) {
      throw new Error("Linear webhook retry delays must be non-negative and below retention");
    }
  }

  public enqueue(candidate: LinearWebhookEnvelope): LinearWebhookEnqueueOutcome {
    const envelope = LinearWebhookEnvelopeSchema.parse(candidate);
    const now = this.clock();
    this.sweepExpired(now);

    if (this.records.has(envelope.deliveryId)) {
      this.emit("duplicate", now, envelope);
      return "duplicate";
    }
    if (this.sessions.size === 0) {
      this.emit("offline", now, envelope, "no_outbound_bridge");
      return "offline";
    }
    if (this.activeDepth() >= this.capacity) {
      this.emit("backpressure", now, envelope, "queue_capacity");
      return "backpressure";
    }

    this.records.set(envelope.deliveryId, {
      envelope,
      state: "pending",
      attempts: 0,
      availableAtMs: now,
      leaseId: null,
      leaseReceipt: null,
    });
    this.emit("accepted", now, envelope);
    return "accepted";
  }

  public async dial(): Promise<LinearWebhookDeliveryChannel> {
    const sessionId = `outbound-bridge-${String(++this.nextSession)}`;
    this.sessions.add(sessionId);
    this.emit("bridge_connected", this.clock());
    let closed = false;

    const assertOpen = (): void => {
      if (closed) throw new Error("Linear webhook delivery channel is closed");
    };
    let outstandingReceipt: LinearWebhookLeaseReceipt | null = null;

    return {
      receive: async (): Promise<LinearWebhookReceivedDelivery | null> => {
        assertOpen();
        if (outstandingReceipt !== null) {
          throw new Error("Linear webhook delivery channel already has an outstanding lease");
        }
        const now = this.clock();
        this.sweepExpired(now);
        for (const record of this.records.values()) {
          if (record.state !== "pending" || record.availableAtMs > now) continue;
          const receipt = Object.freeze({});
          record.state = "in_flight";
          record.attempts += 1;
          record.leaseId = sessionId;
          record.leaseReceipt = receipt;
          this.leasedRecords.set(receipt, record);
          outstandingReceipt = receipt;
          return {
            receipt,
            payload: {
              deliveryId: record.envelope.deliveryId,
              attempt: record.attempts,
              envelope: record.envelope,
            } satisfies LinearWebhookLeasedDelivery,
          };
        }
        return null;
      },
      acknowledge: async (receipt): Promise<void> => {
        assertOpen();
        const record = this.leasedRecord(receipt, sessionId);
        record.state = "delivered";
        this.leasedRecords.delete(receipt);
        record.leaseId = null;
        record.leaseReceipt = null;
        outstandingReceipt = null;
      },
      retry: async (receipt, reason): Promise<"dead_lettered" | "scheduled"> => {
        assertOpen();
        const record = this.leasedRecord(receipt, sessionId);
        const outcome = this.releaseForRetry(record, reason, this.clock());
        outstandingReceipt = null;
        return outcome;
      },
      reject: async (receipt, reason): Promise<void> => {
        assertOpen();
        const record = this.leasedRecord(receipt, sessionId);
        record.state = "rejected";
        this.leasedRecords.delete(receipt);
        record.leaseId = null;
        record.leaseReceipt = null;
        outstandingReceipt = null;
        this.emit("rejected", this.clock(), record.envelope, reason, record.attempts);
      },
      close: async (): Promise<void> => {
        if (closed) return;
        closed = true;
        const now = this.clock();
        for (const record of this.records.values()) {
          if (record.state === "in_flight" && record.leaseId === sessionId) {
            this.releaseForRetry(record, "bridge_disconnected", now);
          }
        }
        outstandingReceipt = null;
        this.sessions.delete(sessionId);
        this.emit("bridge_disconnected", now);
      },
    };
  }

  public snapshot(): LinearWebhookQueueSnapshot {
    this.sweepExpired(this.clock());
    const states = [...this.records.values()].map((record) => record.state);
    return {
      capacity: this.capacity,
      connectedBridges: this.sessions.size,
      queued: states.filter((state) => state === "pending").length,
      inFlight: states.filter((state) => state === "in_flight").length,
      delivered: states.filter((state) => state === "delivered").length,
      failed: states.filter((state) => state === "failed" || state === "rejected").length,
    };
  }

  private leasedRecord(receipt: LinearWebhookLeaseReceipt, sessionId: string): QueueRecord {
    const record = this.leasedRecords.get(receipt);
    if (record?.state !== "in_flight" || record.leaseId !== sessionId) {
      throw new Error("Linear webhook delivery is not leased by this channel");
    }
    return record;
  }

  private releaseForRetry(
    record: QueueRecord,
    reason: LinearWebhookRetryReason,
    now: number,
  ): "dead_lettered" | "scheduled" {
    if (record.leaseReceipt !== null) this.leasedRecords.delete(record.leaseReceipt);
    const delay = this.retryDelaysMs[record.attempts - 1];
    const nextAttemptAtMs = delay === undefined ? undefined : now + delay;
    if (nextAttemptAtMs === undefined || nextAttemptAtMs >= record.envelope.expiresAtMs) {
      record.state = "failed";
      record.leaseId = null;
      record.leaseReceipt = null;
      this.emit("dead_lettered", now, record.envelope, reason, record.attempts);
      return "dead_lettered";
    }
    record.state = "pending";
    record.availableAtMs = nextAttemptAtMs;
    record.leaseId = null;
    record.leaseReceipt = null;
    this.emit("retry_scheduled", now, record.envelope, reason, record.attempts);
    return "scheduled";
  }

  private sweepExpired(now: number): void {
    for (const [deliveryId, record] of this.records) {
      if (now < record.envelope.expiresAtMs) continue;
      if (record.leaseReceipt !== null) this.leasedRecords.delete(record.leaseReceipt);
      if (record.state === "pending" || record.state === "in_flight") {
        this.emit("expired", now, record.envelope, "retention_window", record.attempts);
      }
      this.records.delete(deliveryId);
    }
  }

  private activeDepth(): number {
    let depth = 0;
    for (const record of this.records.values()) {
      if (record.state === "pending" || record.state === "in_flight") depth += 1;
    }
    return depth;
  }

  private emit(
    outcome: LinearWebhookEvidence["outcome"],
    timestampMs: number,
    envelope?: LinearWebhookEnvelope,
    reason?: string,
    attempt?: number,
  ): void {
    this.evidence({
      service: "linear-webhook-ingress",
      outcome,
      timestampMs,
      queueDepth: this.activeDepth(),
      ...(envelope === undefined
        ? {}
        : { deliveryId: envelope.deliveryId, correlationId: envelope.correlationId }),
      ...(reason === undefined ? {} : { reason }),
      ...(attempt === undefined ? {} : { attempt }),
    });
  }
}
