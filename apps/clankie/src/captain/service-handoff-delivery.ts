import { ConversationStore } from "./conversations.ts";
import { SeatOutbox } from "./seat-outbox.ts";

export interface ServiceHandoffDeliveryContext {
  readonly conversations: ConversationStore;
  readonly seatOutbox: (conversationId: string) => SeatOutbox;
  readonly shutdown: AbortSignal;
}

/**
 * ADR 0218: a seat that polls again first receives, as one turn, the service's
 * actual turns since its last known log cursor. Call only after the poll has
 * bound the outbox inside `pollConversationDriver`, so every admitted service
 * drive has finished (and lands in the handoff) and queued inputs follow it.
 */
export function createServiceHandoffDelivery(ctx: ServiceHandoffDeliveryContext) {
  const inFlight = new Set<string>();
  return function deliverServiceHandoff(conversationId: string): void {
    if (inFlight.has(conversationId)) return;
    const outbox = ctx.seatOutbox(conversationId);
    const claim = ctx.conversations.claimServiceHandoff(conversationId);
    if (claim === undefined) return;
    if (claim.kind === "reconcile") {
      // A restart between sealing and settling: only an exact acknowledged
      // receipt proves delivery. Anything else is uncertain and never resent.
      ctx.conversations.settleServiceHandoff(
        conversationId,
        claim.spanId,
        outbox.receipt(claim.text)?.outcome === "delivered" ? "delivered" : "uncertain",
      );
      return;
    }
    // Only this exact handoff's own unresolved original refuses it before take
    // (VUH-1779); reopen the span for a later poll instead of sealing it into uncertainty.
    if (outbox.uncertainFor(claim.text)) {
      ctx.conversations.settleServiceHandoff(conversationId, claim.spanId, "refused");
      return;
    }
    inFlight.add(conversationId);
    void outbox
      .deliver({
        kind: "message",
        conversationId,
        source: "service-handoff",
        content: claim.text,
        wantsReply: false,
        signal: ctx.shutdown,
      })
      .then(
        (result): "delivered" | "refused" | "uncertain" =>
          result.outcome === "delivered" || result.outcome === "replied"
            ? "delivered"
            : result.outcome === "unbound" || result.outcome === "aborted"
              ? "refused"
              : "uncertain",
        () => "uncertain" as const,
      )
      .then((outcome) => {
        // Shutdown before settlement leaves `attempting`, which restart reconciles.
        if (!ctx.shutdown.aborted)
          ctx.conversations.settleServiceHandoff(conversationId, claim.spanId, outcome);
      })
      .catch(() => undefined)
      .finally(() => inFlight.delete(conversationId));
  };
}
