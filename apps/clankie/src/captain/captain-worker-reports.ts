import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { splitFleetQualified } from "../herdr-fleet.ts";
import {
  assertConversationAuthority,
  type ConversationAuthority,
  type ConversationOwner,
  type NativeSeatRecipient,
} from "./conversation-owner.ts";
import { ConversationStore, type ConversationRunner, type InboundReport } from "./conversations.ts";
import { deliveryFingerprint } from "./delivery-fence.ts";
import { type FleetSeatDelivery, type FleetSeatMessageContext } from "./fleet-seat.ts";
import { HerdrWatchStore, type HerdrAgentSnapshot, type HerdrWatchRunner } from "./herdr-watch.ts";
import { type PeerDeliveryOptions } from "./peer-seat-messages.ts";
import { SeatOutbox } from "./seat-outbox.ts";
import type { WorkerReportAcknowledgment } from "./worker-report-tools.ts";
/** A report from a seat that just closed stays unread this long, so its lead still sees it (VUH-2806). */
const CLOSED_SEAT_REPORT_GRACE_MS = 60 * 60_000;
export interface WorkerReportsContext {
  readonly conversations: ConversationStore;
  readonly seatOutboxes: Map<string, SeatOutbox>;
  readonly shutdown: AbortController;
  readonly onChange: () => void;
  readonly observedSeats?: () => readonly { readonly paneId: string; readonly seatId: string }[];
  /** True while connected apps lead this thread (ADR 0304): its reports wait in worker_reports. */
  readonly leadHeld?: (conversationId: string) => boolean;
  readonly validateConversationOwner: (owner: ConversationOwner) => Promise<boolean>;
  readonly herdrRunner: HerdrWatchRunner;
  readonly herdrWatches: HerdrWatchStore;
  /** Append-only audit record of reports retired because their seat is gone. */
  readonly retiredReportsPath: string;
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
    async read(authority: ConversationAuthority, limit?: number, deliveryIds?: readonly string[]) {
      await assertConversationAuthority(authority);
      return ctx.conversations.readInboundReports(authority.owner.conversationId, {
        ...(limit === undefined ? {} : { limit }),
        ...(deliveryIds === undefined ? {} : { deliveryIds }),
      });
    },
    async acknowledge(
      authority: ConversationAuthority,
      ids: readonly string[],
      receipt?: { summary?: string | undefined; links?: string[] | undefined },
    ) {
      await assertConversationAuthority(authority);
      const conversationId = authority.owner.conversationId;
      const reports = new Map(
        ctx.conversations
          .inboundReports(conversationId, { includeRead: true })
          .map((report) => [report.deliveryId, report]),
      );
      const result: WorkerReportAcknowledgment = {
        acknowledged: false,
        appliedDeliveryIds: [],
        refused: [],
        unanswered: [],
      };
      for (const deliveryId of new Set(ids)) {
        const report = reports.get(deliveryId);
        const reason = !report
          ? "unknown"
          : report.reportDelivery.state === "read"
            ? "already_acknowledged"
            : !report.reportDelivery.offeredAt
              ? "not_offered"
              : undefined;
        if (reason) result.refused.push({ deliveryId, reason });
        else result.appliedDeliveryIds.push(deliveryId);
      }
      // Classify and persist in one synchronous step after checking authority.
      // The store still enforces offered-only acknowledgment and rolls back failed writes.
      if (
        result.appliedDeliveryIds.length > 0 &&
        !ctx.conversations.acknowledgeInboundReports(conversationId, result.appliedDeliveryIds, receipt)
      )
        throw new Error("Worker reports could not be acknowledged; call worker_reports first.");
      result.acknowledged = result.appliedDeliveryIds.length > 0 && result.refused.length === 0;
      result.unanswered = ctx.conversations.unansweredInboundReports(
        conversationId,
        result.appliedDeliveryIds,
      );
      return result;
    },
  };

  ctx.conversations.onInboundReportChange = () => ctx.onChange();
  function reportSummaries(
    conversationId?: string,
    native?: HerdrAgentSnapshot,
    includeRead = false,
    acceptedAfterMs?: number,
  ) {
    const seatIds = new Map((ctx.observedSeats?.() ?? []).map((seat) => [seat.paneId, seat.seatId]));
    return ctx.conversations
      .inboundReportSummaries(conversationId, {
        includeRead,
        ...(acceptedAfterMs === undefined ? {} : { acceptedAfterMs }),
        ...(native === undefined
          ? {}
          : { sender: { paneId: native.paneId, binding: ctx.inboundBinding(native) } }),
      })
      .slice(-1000)
      .map((report) => {
        const seatId = seatIds.get(report.paneId);
        return seatId === undefined ? report : { ...report, seatId };
      });
  }

  /**
   * While connected apps lead (ADR 0304) a report runs no turn of Clankie's: it is
   * stored and stays unread, so the apps read it with worker_reports.
   */
  const serviceOrHeld: ConversationRunner = (conversationId, content, publish, context) => {
    if (ctx.leadHeld?.(conversationId) === true) {
      context.deliveryReceipt?.("stored");
      return Promise.resolve();
    }
    return ctx.conversations.serviceRunner(conversationId, content, publish, context);
  };

  function conversationReportRunner(owner: ConversationOwner, deliveryId: string): ConversationRunner {
    return async (conversationId, prompt, publish, context) => {
      if (context.signal.aborted || !(await ctx.validateConversationOwner(owner)))
        throw new Error("Worker report owner is unavailable");
      const outbox = ctx.seatOutboxes.get(conversationId);
      const lead = ctx.conversations.inboundAcceptance(deliveryId)?.leadMessageFrom;
      const content = lead ? prompt : `Worker report ${deliveryId}\n${prompt}`;
      const source = lead ? "lead" : "worker-report";
      const receipt = outbox?.receipt(content);
      if (receipt?.outcome === "delivered") {
        context.deliveryReceipt?.("delivered");
        return;
      }
      // ADR 0218: with no live seat, the service runs the conversation. Its
      // driver fence rechecks the seat, so a seat that binds meanwhile still wins.
      // Only this report's own unresolved original stays with the seat; another
      // delivery's unresolved receipt never holds it back (VUH-1779).
      if (!outbox?.routesToSeat(content)) return serviceOrHeld(conversationId, content, publish, context);
      const result = await outbox!.deliver({
        kind: "message",
        conversationId,
        source,
        content,
        wantsReply: false,
        signal: context.signal,
      });
      // Nothing was taken: the seat that held the route (a restart's reconnect
      // grace, or a poll gap) never came back, so the service runs it after all.
      if (result.outcome === "unbound") return serviceOrHeld(conversationId, content, publish, context);
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
  /**
   * Retire unread reports whose sending pane a complete listing of its own fleet no
   * longer shows (VUH-2806). A fleet that cannot be listed retires nothing, and any
   * pane still present keeps every report it ever sent, whatever session it now runs.
   */
  async function retireClosedSeatReports(now = Date.now()) {
    const cutoff = now - CLOSED_SEAT_REPORT_GRACE_MS;
    const candidates = ctx.conversations
      .inboundReports()
      .filter(
        (report) =>
          (report.reportDelivery.state === "delivered" || report.reportDelivery.state === "uncertain") &&
          Date.parse(report.acceptedAt) <= cutoff,
      );
    const inventories = new Map<string, Set<string> | undefined>();
    for (const fleet of new Set(candidates.map((report) => splitFleetQualified(report.paneId)?.fleet))) {
      if (ctx.shutdown.signal.aborted || !ctx.herdrRunner.list) return [];
      const panes = await ctx.herdrRunner.list(fleet).then(
        (inventory) => new Set(inventory.map((agent) => agent.paneId)),
        () => undefined,
      );
      inventories.set(fleet ?? "", panes);
    }
    const gone = new Map<string, string[]>();
    for (const report of candidates) {
      const panes = inventories.get(splitFleetQualified(report.paneId)?.fleet ?? "");
      if (panes === undefined || panes.has(report.paneId)) continue;
      gone.set(report.conversationId, [...(gone.get(report.conversationId) ?? []), report.deliveryId]);
    }
    const retired: { conversationId: string; deliveryIds: string[] }[] = [];
    for (const [conversationId, ids] of gone) {
      if (ctx.shutdown.signal.aborted) break;
      const deliveryIds = ctx.conversations.retireInboundReports(conversationId, ids, (reports) =>
        appendRetiredReports(ctx.retiredReportsPath, reports, new Date(now).toISOString()),
      );
      if (deliveryIds.length === 0) continue;
      retired.push({ conversationId, deliveryIds });
      ctx.conversations.recordServiceNotice(
        conversationId,
        `Retired ${deliveryIds.length === 1 ? "an unread worker report" : `${deliveryIds.length} unread worker reports`} whose seat has closed, so worker_reports shows live seats. Their full text is kept in ${ctx.retiredReportsPath}.`,
      );
    }
    return retired;
  }
  return {
    retireClosedSeatReports,
    workerReportActions,
    reportSummaries,
    conversationReportRunner,
    recoverWorkerReports,
    recoverAllWorkerReports,
  };
}

/** One JSON line per retired report, durable before the store marks any of them read. */
function appendRetiredReports(path: string, reports: readonly InboundReport[], retiredAt: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lines = reports
    .map((report) =>
      JSON.stringify({
        retiredAt,
        reason: "sender_pane_closed",
        conversationId: report.conversationId,
        deliveryId: report.deliveryId,
        paneId: report.paneId,
        binding: report.binding,
        acceptedAt: report.acceptedAt,
        state: report.reportDelivery.state,
        ...(report.reportDelivery.stage === undefined ? {} : { stage: report.reportDelivery.stage }),
        text: report.text,
      }),
    )
    .join("\n");
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, `${lines}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
