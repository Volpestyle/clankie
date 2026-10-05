import type {
  FleetSeatMessageDelivery,
  FleetSeatMessageReceipt,
  WorkerReportRouting,
} from "@clankie/protocol";
import { randomUUID } from "node:crypto";
import { DeliveryFence, deliveryFingerprint } from "./delivery-fence.ts";
import type { ConversationRunner, ConversationStore, InboundReportRecipient } from "./conversations.ts";

export const INBOUND_REQUEST_DEADLINE_MS = 20_000;
export interface InboundSeatRequest {
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
}
interface InboundAttempt {
  readonly paneId: string;
  readonly delivery: FleetSeatMessageDelivery;
  readonly fingerprint: string;
  readonly stamp: { instanceId: string; deadlineAt: number };
  readonly signal: AbortSignal | undefined;
}

/** Admission fence; the conversation retains report delivery and explicit read state. */
export class InboundSeatReceipts {
  private readonly fencePath: string;
  private readonly conversations: Pick<ConversationStore, "inboundAcceptance" | "submitInbound">;
  private readonly instanceId: string;
  private readonly now: () => number;
  private readonly deadlineMs: number;
  private readonly shutdown: AbortSignal | undefined;
  private readonly active = new Map<string, InboundAttempt>();
  public constructor(
    path: string,
    conversations: Pick<ConversationStore, "inboundAcceptance" | "submitInbound">,
    options: { instanceId?: string; now?: () => number; deadlineMs?: number; signal?: AbortSignal } = {},
  ) {
    this.fencePath = path;
    this.conversations = conversations;
    this.instanceId = options.instanceId ?? randomUUID();
    this.now = options.now ?? Date.now;
    this.deadlineMs = options.deadlineMs ?? INBOUND_REQUEST_DEADLINE_MS;
    this.shutdown = options.signal;
  }

  private abandoned(attempt: InboundAttempt): boolean {
    return !!this.shutdown?.aborted || !!attempt.signal?.aborted || this.now() >= attempt.stamp.deadlineAt;
  }

  /** Register before asynchronous routing, so lookup cannot seal a live original. */
  public async trackAttempt(
    paneId: string,
    delivery: FleetSeatMessageDelivery,
    text: string,
    run: () => Promise<FleetSeatMessageReceipt>,
    request?: InboundSeatRequest,
  ): Promise<FleetSeatMessageReceipt> {
    const fingerprint = deliveryFingerprint(text);
    const previous = this.reconcile(paneId, delivery, fingerprint);
    if (previous.received || previous.definitive) return previous;
    if (this.active.has(delivery.id)) return this.lookup(paneId, delivery, fingerprint);
    const attempt: InboundAttempt = {
      paneId,
      delivery,
      fingerprint,
      stamp: {
        instanceId: this.instanceId,
        deadlineAt: Math.min(request?.deadlineAt ?? Infinity, this.now() + this.deadlineMs),
      },
      signal: request?.signal,
    };
    this.active.set(delivery.id, attempt);
    try {
      if (this.abandoned(attempt)) return this.lookup(paneId, delivery, fingerprint);
      return await run();
    } finally {
      this.active.delete(delivery.id);
    }
  }

  /** A delayed original must see terminal IDs written by a replacement service. */
  private get fence(): DeliveryFence {
    return new DeliveryFence(this.fencePath);
  }

  public reconcile(
    paneId: string,
    delivery: FleetSeatMessageDelivery,
    fingerprint: string,
  ): FleetSeatMessageReceipt {
    const receipt: FleetSeatMessageReceipt = {
      schemaVersion: 1,
      received: false,
      deliveryStage: "uncertain",
      deliveryId: delivery.id,
      binding: delivery.binding,
      fingerprint,
    };
    try {
      const accepted = this.conversations.inboundAcceptance(delivery.id);
      const attempted = this.fence.pending(`id:${delivery.id}`);
      if (
        !accepted &&
        attempted?.notSent &&
        attempted.messageId === delivery.id &&
        attempted.paneId === paneId &&
        attempted.fingerprint === fingerprint &&
        attempted.sessionId === delivery.binding
      )
        return {
          ...receipt,
          deliveryStage: "unavailable",
          definitive: "not_sent",
          detail: "This original delivery was not accepted and its ID is sealed; nothing was sent.",
        };
      if (
        !accepted ||
        accepted.paneId !== paneId ||
        accepted.binding !== delivery.binding ||
        accepted.fingerprint !== fingerprint ||
        deliveryFingerprint(accepted.text) !== fingerprint
      )
        return receipt;
      if (
        attempted &&
        (attempted.messageId !== delivery.id ||
          attempted.paneId !== paneId ||
          attempted.fingerprint !== fingerprint ||
          attempted.sessionId !== delivery.binding)
      )
        return receipt;
      const pending = this.fence.pending(paneId);
      if (
        pending &&
        (pending.messageId !== delivery.id ||
          pending.fingerprint !== fingerprint ||
          pending.sessionId !== delivery.binding)
      )
        return receipt;
      if (pending) {
        // The replacement owns receipt writes after shutdown/lease handoff.
        // Keep the worker's claim until that instance clears the exact pane;
        // returning stored here would strand its next ID behind this fence.
        if (this.shutdown?.aborted) return receipt;
        this.fence.reconcile(paneId, delivery.id);
      }
      return { ...receipt, received: true, deliveryStage: "stored" };
    } catch {
      return receipt;
    }
  }

  /** Authenticated exact lookup can prove absence only after fencing delayed original delivery. */
  public lookup(
    paneId: string,
    delivery: FleetSeatMessageDelivery,
    fingerprint: string,
  ): FleetSeatMessageReceipt {
    const previous = this.reconcile(paneId, delivery, fingerprint);
    if (previous.received || previous.definitive || this.shutdown?.aborted) return previous;
    try {
      if (this.conversations.inboundAcceptance(delivery.id)) return previous;
      const fence = this.fence;
      const pending = fence.pending(paneId);
      const attempted = fence.pending(`id:${delivery.id}`);
      const active = this.active.get(delivery.id);
      if (
        active &&
        (active.paneId !== paneId ||
          active.delivery.binding !== delivery.binding ||
          active.fingerprint !== fingerprint)
      )
        return previous;
      const matches = (value: {
        messageId: string;
        paneId?: string | undefined;
        sessionId?: string | undefined;
        fingerprint: string;
      }) =>
        value.messageId === delivery.id &&
        value.paneId === paneId &&
        value.sessionId === delivery.binding &&
        value.fingerprint === fingerprint;
      if (pending) {
        if (!matches(pending) || (attempted && !matches(attempted))) return previous;
        if (
          attempted &&
          (attempted.inboundAttempt?.instanceId !== pending.inboundAttempt?.instanceId ||
            attempted.inboundAttempt?.deadlineAt !== pending.inboundAttempt?.deadlineAt)
        )
          return previous;
        const owner = pending.inboundAttempt;
        // A replacement may retire prior/legacy attempts only because the service
        // process lock excludes a live old instance. Shutdown invalidates its tokens
        // before releasing that lock. Same-instance originals remain protected until
        // their final acceptance guard can no longer allow a write.
        if (
          owner?.instanceId === this.instanceId &&
          this.now() < owner.deadlineAt &&
          !this.shutdown?.aborted &&
          !(active && this.abandoned(active))
        )
          return previous;
      } else {
        if (attempted) return previous;
        if (active && !this.abandoned(active)) return previous;
      }
      if (
        !fence.sealInboundAbsence(paneId, {
          messageId: delivery.id,
          paneId,
          sessionId: delivery.binding,
          fingerprint,
        })
      )
        return previous;
      return this.reconcile(paneId, delivery, fingerprint);
    } catch {
      return previous;
    }
  }

  /** A known refusal before any original attempt may carry its honest stage. */
  public refuse(paneId: string, delivery: FleetSeatMessageDelivery, text: string): FleetSeatMessageReceipt {
    const receipt: FleetSeatMessageReceipt = {
      schemaVersion: 1,
      received: false,
      deliveryStage: "uncertain",
      deliveryId: delivery.id,
      binding: delivery.binding,
      fingerprint: deliveryFingerprint(text),
    };
    try {
      if (
        this.fence.pending(paneId) ||
        this.fence.pending(`id:${delivery.id}`) ||
        this.conversations.inboundAcceptance(delivery.id)
      )
        return receipt;
      return { ...receipt, deliveryStage: "unavailable" };
    } catch {
      return receipt;
    }
  }

  public accept(
    paneId: string,
    delivery: FleetSeatMessageDelivery,
    text: string,
    message: string,
    /** Resolved by the host before acceptance, never supplied by the worker. */
    conversationId = "global-default",
    /** An admitted room route keeps its authority and existing reply mouth. */
    runner?: ConversationRunner,
    workerReportRouting?: WorkerReportRouting,
    /** Host-captured original destination; used only after renewed authority checks. */
    recipient?: InboundReportRecipient,
  ): FleetSeatMessageReceipt {
    const fingerprint = deliveryFingerprint(text);
    const previous = this.reconcile(paneId, delivery, fingerprint);
    if (previous.received || previous.definitive) return previous;
    const attempt = this.active.get(delivery.id);
    if (
      this.shutdown?.aborted ||
      (attempt &&
        (attempt.paneId !== paneId ||
          attempt.delivery.binding !== delivery.binding ||
          attempt.fingerprint !== fingerprint ||
          this.abandoned(attempt)))
    )
      return this.lookup(paneId, delivery, fingerprint);
    try {
      // An existing ID with different evidence, a corrupt record, or any pending
      // original blocks replacement. Read before begin; absent is not accepted.
      if (
        this.conversations.inboundAcceptance(delivery.id) ||
        this.fence.pending(paneId) ||
        this.fence.pending(`id:${delivery.id}`)
      )
        return previous;
      const inboundAttempt = attempt?.stamp ?? {
        instanceId: this.instanceId,
        deadlineAt: this.now() + this.deadlineMs,
      };
      this.fence.begin(paneId, {
        messageId: delivery.id,
        fingerprint,
        sessionId: delivery.binding,
        paneId,
        inboundAttempt,
      });
      // Keep the attempted ID as a tombstone after its pending pane fence is
      // reconciled. Loss/reset of conversation proof must not reopen that ID.
      this.fence.begin(`id:${delivery.id}`, {
        messageId: delivery.id,
        fingerprint,
        sessionId: delivery.binding,
        paneId,
        inboundAttempt,
      });
      // The synchronous fence writes can consume the remaining request budget.
      // Recheck just before durable acceptance; an expired original never lands later.
      if (
        this.shutdown?.aborted ||
        (attempt ? this.abandoned(attempt) : this.now() >= inboundAttempt.deadlineAt)
      )
        return this.lookup(paneId, delivery, fingerprint);
      this.conversations.submitInbound(
        message,
        {
          deliveryId: delivery.id,
          binding: delivery.binding,
          fingerprint,
          paneId,
          text,
          ...(workerReportRouting === undefined ? {} : { workerReportRouting }),
          ...(recipient === undefined ? {} : { recipient }),
        },
        conversationId,
        runner,
      );
      return this.reconcile(paneId, delivery, fingerprint);
    } catch {
      return previous;
    }
  }
}
