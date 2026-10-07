import {
  assertConversationAuthority,
  type ConversationAuthority,
  type ConversationOwner,
  type NativeSeatRecipient,
} from "./conversation-owner.ts";
import { ConversationStore, type ConversationRunner } from "./conversations.ts";
import { deliveryFingerprint } from "./delivery-fence.ts";
import { type FleetSeatDelivery, type FleetSeatMessageContext } from "./fleet-seat.ts";
import { HerdrWatchStore, type HerdrAgentSnapshot, type HerdrWatchRunner } from "./herdr-watch.ts";
import { type PeerDeliveryOptions } from "./peer-seat-messages.ts";
import { SeatOutbox } from "./seat-outbox.ts";
export interface WorkerReportsContext {
  readonly conversations: ConversationStore;
  readonly seatOutboxes: Map<string, SeatOutbox>;
  readonly shutdown: AbortController;
  readonly onChange: () => void;
  readonly validateConversationOwner: (owner: ConversationOwner) => Promise<boolean>;
  readonly herdrRunner: HerdrWatchRunner;
  readonly herdrWatches: HerdrWatchStore;
  readonly inboundBinding: (agent: HerdrAgentSnapshot | undefined) => string | undefined;
  readonly nativeRecipientCurrent: (recipient: NativeSeatRecipient) => Promise<boolean>;
  readonly deliverToSeat: (
    seatId: string,
    message: string,
    context: FleetSeatMessageContext,
    options?: PeerDeliveryOptions,
  ) => Promise<FleetSeatDelivery>;
}
export function createWorkerReports(ctx: WorkerReportsContext) {
  const workerReportActions = {
    async read(authority: ConversationAuthority, limit?: number) {
      await assertConversationAuthority(authority);
      return ctx.conversations.readInboundReports(
        authority.owner.conversationId,
        limit === undefined ? {} : { limit },
      );
    },
    async acknowledge(authority: ConversationAuthority, ids: readonly string[]) {
      await assertConversationAuthority(authority);
      return ctx.conversations.acknowledgeInboundReports(authority.owner.conversationId, ids);
    },
  };

  ctx.conversations.onInboundReportChange = ctx.onChange;
  function reportSummaries(
    conversationId?: string,
    native?: HerdrAgentSnapshot,
    includeRead = false,
    acceptedAfterMs?: number,
  ) {
    return ctx.conversations
      .inboundReports(conversationId, {
        includeRead,
        ...(acceptedAfterMs === undefined ? {} : { acceptedAfterMs }),
      })
      .filter(
        (report) =>
          native === undefined ||
          (report.paneId === native.paneId && report.binding === ctx.inboundBinding(native)),
      )
      .slice(-1000)
      .map((report) => ({
        deliveryId: report.deliveryId,
        conversationId: report.conversationId,
        paneId: report.paneId,
        acceptedAt: report.acceptedAt,
        state: report.reportDelivery.state,
        ...(report.reportDelivery.stage === undefined ? {} : { stage: report.reportDelivery.stage }),
      }));
  }

  function conversationReportRunner(owner: ConversationOwner, deliveryId: string): ConversationRunner {
    return async (conversationId, prompt, publish, context) => {
      if (context.signal.aborted || !(await ctx.validateConversationOwner(owner)))
        throw new Error("Worker report owner is unavailable");
      const outbox = ctx.seatOutboxes.get(conversationId);
      const content = `Worker report ${deliveryId}\n${prompt}`;
      const receipt = outbox?.receipt(content);
      if (receipt?.outcome === "delivered") {
        context.deliveryReceipt?.("delivered");
        return;
      }
      // ADR 0218: with no live seat, the service runs the conversation. Its
      // driver fence rechecks the seat, so a seat that binds meanwhile still wins.
      // Only this report's own unresolved original stays with the seat; another
      // delivery's unresolved receipt never holds it back (VUH-1779).
      if (!outbox?.routesToSeat(content))
        return ctx.conversations.serviceRunner(conversationId, content, publish, context);
      const result = await outbox!.deliver({
        kind: "message",
        conversationId,
        source: "worker-report",
        content,
        wantsReply: false,
        signal: context.signal,
      });
      context.deliveryReceipt?.(result.deliveryStage ?? "uncertain");
      if (result.outcome !== "delivered" && result.outcome !== "replied")
        throw new Error("Worker report native delivery remains unavailable");
    };
  }

  const reportRecovery = new Set<string>();

  async function recoverWorkerReports(conversationId: string) {
    if (ctx.shutdown.signal.aborted || reportRecovery.has(conversationId)) return;
    reportRecovery.add(conversationId);
    try {
      for (const report of ctx.conversations.inboundReports(conversationId)) {
        if (report.reportDelivery.state !== "pending" || report.recipient === undefined) continue;
        const recipient = report.recipient;
        if (report.workerReportRouting?.source === "refused") {
          const sender = await ctx.herdrRunner.get(report.paneId).catch(() => undefined);
          if (ctx.inboundBinding(sender) !== report.binding) continue;
          try {
            if (
              !sender ||
              recipient.kind !== "conversation" ||
              JSON.stringify(ctx.herdrWatches.nativeOwner(sender)) !== JSON.stringify(recipient.owner)
            )
              continue;
          } catch {
            continue;
          }
        }
        let runner: ConversationRunner;
        if (recipient.kind === "conversation") {
          if (
            recipient.owner.conversationId !== conversationId ||
            recipient.owner.discord !== undefined ||
            !(await ctx.validateConversationOwner(recipient.owner))
          )
            continue;
          runner = conversationReportRunner(recipient.owner, report.deliveryId);
        } else {
          if (!(await ctx.nativeRecipientCurrent(recipient))) continue;
          runner = async (_id, prompt, _publish, context) => {
            const guard = async () => {
              if (context.signal.aborted || !(await ctx.nativeRecipientCurrent(recipient)))
                throw new Error("Original worker-report recipient changed");
            };
            const result = await ctx.deliverToSeat(
              recipient.seatId,
              `Worker report ${report.deliveryId}\n${prompt}`,
              {
                conversationId,
                source: "worker-report",
              },
              {
                guard,
                recipientBinding: recipient.binding,
                stableReceiptKey: `worker-report:${deliveryFingerprint(JSON.stringify([report.deliveryId, recipient]))}`,
              },
            );
            context.deliveryReceipt?.(result.deliveryStage ?? "uncertain");
            if (result.outcome !== "delivered") throw new Error("Worker report remains undelivered");
          };
        }
        ctx.conversations.retryInboundReport(report.deliveryId, runner);
      }
    } finally {
      reportRecovery.delete(conversationId);
    }
  }
  /** Definitely undispatched reports need no seat: the service may run them (ADR 0218). */
  function recoverAllWorkerReports() {
    const pending = new Set(
      ctx.conversations
        .inboundReports()
        .filter((report) => report.reportDelivery.state === "pending")
        .map((report) => report.conversationId),
    );
    for (const conversationId of pending) void recoverWorkerReports(conversationId).catch(() => undefined);
  }
  return {
    workerReportActions,
    reportSummaries,
    conversationReportRunner,
    recoverWorkerReports,
    recoverAllWorkerReports,
  };
}
