import type { FleetSeatMessageDelivery, FleetSeatMessageReceipt } from "@clankie/protocol";
import { DeliveryFence, deliveryFingerprint } from "./delivery-fence.ts";
import type { ConversationStore } from "./conversations.ts";

/** A guard around conversation acceptance, never a replay queue. */
export class InboundSeatReceipts {
  private readonly fence: DeliveryFence;
  private readonly conversations: Pick<ConversationStore, "inboundAcceptance" | "submitInbound">;
  public constructor(
    path: string,
    conversations: Pick<ConversationStore, "inboundAcceptance" | "submitInbound">,
  ) {
    this.fence = new DeliveryFence(path);
    this.conversations = conversations;
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
      if (
        !accepted ||
        accepted.paneId !== paneId ||
        accepted.binding !== delivery.binding ||
        accepted.fingerprint !== fingerprint ||
        deliveryFingerprint(accepted.text) !== fingerprint
      )
        return receipt;
      const attempted = this.fence.pending(`id:${delivery.id}`);
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
  ): FleetSeatMessageReceipt {
    const fingerprint = deliveryFingerprint(text);
    const previous = this.reconcile(paneId, delivery, fingerprint);
    if (previous.received) return previous;
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
      this.conversations.submitInbound(message, {
        deliveryId: delivery.id,
        binding: delivery.binding,
        fingerprint,
        paneId,
        text,
      });
      return this.reconcile(paneId, delivery, fingerprint);
    } catch {
      return previous;
    }
  }
}
