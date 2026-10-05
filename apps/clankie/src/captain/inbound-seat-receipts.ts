import type {
  FleetSeatMessageDelivery,
  FleetSeatMessageReceipt,
  WorkerReportRouting,
} from "@clankie/protocol";
import { DeliveryFence, deliveryFingerprint } from "./delivery-fence.ts";
import type { ConversationRunner, ConversationStore, InboundReportRecipient } from "./conversations.ts";

/** Admission fence; the conversation retains report delivery and explicit read state. */
export class InboundSeatReceipts {
  private readonly fencePath: string;
  private readonly conversations: Pick<ConversationStore, "inboundAcceptance" | "submitInbound">;
  public constructor(
    path: string,
    conversations: Pick<ConversationStore, "inboundAcceptance" | "submitInbound">,
  ) {
    this.fencePath = path;
    this.conversations = conversations;
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
      if (pending) this.fence.reconcile(paneId, delivery.id);
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
    if (previous.received || previous.definitive) return previous;
    try {
      if (
        this.conversations.inboundAcceptance(delivery.id) ||
        this.fence.pending(paneId) ||
        this.fence.pending(`id:${delivery.id}`)
      )
        return previous;
      this.fence.begin(`id:${delivery.id}`, {
        messageId: delivery.id,
        paneId,
        sessionId: delivery.binding,
        fingerprint,
        notSent: true,
      });
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
    try {
      // An existing ID with different evidence, a corrupt record, or any pending
      // original blocks replacement. Read before begin; absent is not accepted.
      if (
        this.conversations.inboundAcceptance(delivery.id) ||
        this.fence.pending(paneId) ||
        this.fence.pending(`id:${delivery.id}`)
      )
        return previous;
      this.fence.begin(paneId, { messageId: delivery.id, fingerprint, sessionId: delivery.binding, paneId });
      // Keep the attempted ID as a tombstone after its pending pane fence is
      // reconciled. Loss/reset of conversation proof must not reopen that ID.
      this.fence.begin(`id:${delivery.id}`, {
        messageId: delivery.id,
        fingerprint,
        sessionId: delivery.binding,
        paneId,
      });
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
