import {
  type DeliveryStage,
  type SubmitOperatorConversationTurnResult,
  type WorkerReportPage,
} from "@clankie/protocol";
import { z } from "zod";
import { InboundAcceptanceSchema, WORKER_REPORT_PAGE_BYTES } from "./constants.ts";
import type { ConversationStore } from "./store.ts";
import { type ConversationMeta, type ConversationRunner, type InboundReport } from "./types.ts";

export function restoreInboundReports(ctx: ConversationStore, meta: ConversationMeta): void {
  if (meta.inboundAcceptances === undefined) return;
  const entries = z.record(z.string(), InboundAcceptanceSchema).parse(meta.inboundAcceptances);
  const events = ctx["readEvents"](meta.conversationId);
  for (const [id, receipt] of Object.entries(entries)) {
    if (id !== receipt.deliveryId) throw new Error("Mismatched acceptance ID");
    receipt.acceptedAt ??=
      events.find(
        (event) => event.type === "turn" && event.phase === "accepted" && event.runId === receipt.runId,
      )?.occurredAt ?? meta.createdAt;
    // Old runs and crash-interrupted attempts have no proof of whether a
    // native handoff happened. Keep their payloads visible, never replay them.
    receipt.reportDelivery ??= { state: "uncertain", stage: "uncertain" };
    if (receipt.reportDelivery.state === "attempting")
      receipt.reportDelivery = { ...receipt.reportDelivery, state: "uncertain", stage: "uncertain" };
  }
  meta.inboundAcceptances = entries;
  ctx["saveMeta"](meta);
}

export function hasUnreadInboundReports(meta: ConversationMeta): boolean {
  return Object.values(meta.inboundAcceptances ?? {}).some(
    (receipt) => receipt.reportDelivery?.state !== "read",
  );
}

export function notifyInboundReportChange(ctx: ConversationStore): void {
  try {
    ctx["onInboundReportChange"]?.();
  } catch {
    // Observers never change durable admission or dispatch evidence.
  }
}

/** Retained reports survive event trimming, restart and a vanished worker pane. */
export function inboundReports(
  ctx: ConversationStore,
  conversationId?: string,
  options: { includeRead?: boolean } = {},
): InboundReport[] {
  return [...ctx["metas"].values()]
    .filter((meta) => conversationId === undefined || meta.conversationId === conversationId)
    .flatMap((meta) =>
      Object.values(meta.inboundAcceptances ?? {}).map((value) => {
        const receipt = InboundAcceptanceSchema.parse(value);
        return {
          ...receipt,
          conversationId: meta.conversationId,
          acceptedAt: receipt.acceptedAt ?? meta.createdAt,
          reportDelivery: receipt.reportDelivery ?? {
            state: "uncertain" as const,
            stage: "uncertain" as const,
          },
        };
      }),
    )
    .filter((receipt) => options.includeRead || receipt.reportDelivery.state !== "read")
    .sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt) || a.deliveryId.localeCompare(b.deliveryId));
}

/** Offering full, bounded payloads does not mark them read. */
export function readInboundReports(
  ctx: ConversationStore,
  conversationId: string,
  options: { limit?: number | undefined } = {},
): WorkerReportPage {
  const meta = ctx["metas"].get(conversationId);
  if (!meta) throw new Error("Unknown worker-report conversation");
  const unread = ctx["inboundReports"](conversationId);
  const items: WorkerReportPage["items"] = [];
  for (const report of unread.slice(0, Math.min(100, Math.max(1, options.limit ?? 20)))) {
    const item = {
      deliveryId: report.deliveryId,
      conversationId,
      paneId: report.paneId,
      acceptedAt: report.acceptedAt,
      state: report.reportDelivery.state,
      ...(report.reportDelivery.stage === undefined ? {} : { stage: report.reportDelivery.stage }),
      text: report.text,
    };
    // Bound the whole page, including its envelope and acknowledgment IDs.
    // The Linear budget cannot fit every valid 16,384-unit worker message.
    const offered = [...items, item];
    const size = Buffer.byteLength(
      JSON.stringify({
        conversationId,
        items: offered,
        unreadCount: unread.length,
        ackDeliveryIds: offered.map((entry) => entry.deliveryId),
      }),
      "utf8",
    );
    if (size > WORKER_REPORT_PAGE_BYTES) break;
    items.push(item);
  }
  if (items.length === 0 && unread.length > 0)
    throw new Error("Worker report exceeds the inbox output budget; it remains unread.");
  const now = new Date().toISOString();
  const before = new Map(
    items.map((report) => [report.deliveryId, meta.inboundAcceptances![report.deliveryId]!.reportDelivery]),
  );
  for (const report of items) {
    const receipt = meta.inboundAcceptances![report.deliveryId]!;
    receipt.reportDelivery = { ...receipt.reportDelivery!, offeredAt: now };
  }
  if (items.length > 0) {
    try {
      ctx["saveMeta"](meta);
    } catch (error) {
      for (const [id, delivery] of before) meta.inboundAcceptances![id]!.reportDelivery = delivery;
      throw error;
    }
  }
  return {
    conversationId,
    items,
    unreadCount: unread.length,
    ackDeliveryIds: items.map((report) => report.deliveryId),
  };
}

/** An authenticated recipient explicitly acknowledges only reports it was offered. */
export function acknowledgeInboundReports(
  ctx: ConversationStore,
  conversationId: string,
  deliveryIds: readonly string[],
  options: { reviewedHistory?: boolean } = {},
): boolean {
  const meta = ctx["metas"].get(conversationId);
  if (!meta || deliveryIds.length === 0 || deliveryIds.length > (options.reviewedHistory ? 1000 : 100))
    return false;
  const receipts = deliveryIds.map((id) => meta.inboundAcceptances?.[id]);
  if (
    receipts.some((receipt) => !receipt || (!options.reviewedHistory && !receipt.reportDelivery?.offeredAt))
  )
    return false;
  const before = structuredClone(meta.inboundAcceptances);
  for (const receipt of receipts) {
    receipt!.reportDelivery = {
      ...receipt!.reportDelivery!,
      state: "read",
      readAt: new Date().toISOString(),
    };
  }
  try {
    ctx["saveMeta"](meta);
  } catch (error) {
    if (before === undefined) delete meta.inboundAcceptances;
    else meta.inboundAcceptances = before;
    throw error;
  }
  ctx["notifyInboundReportChange"]();
  return true;
}

/** A native transport receipt is progress, never an acknowledgment that the lead read it. */
export function recordInboundReportDelivery(
  ctx: ConversationStore,
  deliveryId: string,
  stage: DeliveryStage,
): boolean {
  const meta = [...ctx["metas"].values()].find((entry) => entry.inboundAcceptances?.[deliveryId]);
  const receipt = meta?.inboundAcceptances?.[deliveryId];
  if (!meta || !receipt) return false;
  if (receipt.reportDelivery?.state === "read") return true;
  const before = receipt.reportDelivery;
  const state =
    stage === "unavailable" || stage === "rejected"
      ? "pending"
      : stage === "uncertain" || stage === "expired"
        ? "uncertain"
        : "delivered";
  receipt.reportDelivery = {
    ...before,
    state,
    stage,
    ...(state === "delivered" ? { deliveredAt: new Date().toISOString() } : {}),
  };
  try {
    ctx["saveMeta"](meta);
  } catch (error) {
    receipt.reportDelivery = before;
    throw error;
  }
  ctx["notifyInboundReportChange"]();
  return true;
}

/** Retry only definite non-dispatch; the host must revalidate the saved recipient first. */
export function retryInboundReport(
  ctx: ConversationStore,
  deliveryId: string,
  admittedRunner: ConversationRunner,
): SubmitOperatorConversationTurnResult | undefined {
  const meta = [...ctx["metas"].values()].find((entry) => entry.inboundAcceptances?.[deliveryId]);
  const receipt = meta?.inboundAcceptances?.[deliveryId];
  if (!meta || !receipt || receipt.reportDelivery?.state !== "pending" || ctx["runs"].has(receipt.runId))
    return undefined;
  const {
    message,
    runId: _runId,
    acceptedCursor: _acceptedCursor,
    acceptedAt: _acceptedAt,
    reportDelivery: _reportDelivery,
    ...original
  } = receipt;
  return ctx["enqueue"](meta, message, undefined, false, admittedRunner, {
    origin: "message",
    inboundReceipt: original,
  });
}
