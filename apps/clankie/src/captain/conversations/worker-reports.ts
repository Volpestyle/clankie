import {
  type DeliveryStage,
  type OperatorSeatEvent,
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
  options: { includeRead?: boolean; acceptedAfterMs?: number } = {},
): InboundReport[] {
  return [...ctx["metas"].values()]
    .filter((meta) => conversationId === undefined || meta.conversationId === conversationId)
    .flatMap((meta) =>
      Object.values(meta.inboundAcceptances ?? {})
        .filter(
          (value) =>
            options.acceptedAfterMs === undefined ||
            Date.parse(value.acceptedAt ?? meta.createdAt) > options.acceptedAfterMs,
        )
        .map((value) => {
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
    receipt.reportDelivery = {
      ...receipt.reportDelivery!,
      offeredAt: now,
      takenAt: receipt.reportDelivery?.takenAt ?? now,
      senderNotifications: true,
    };
  }
  if (items.length > 0) {
    try {
      ctx["saveMeta"](meta);
    } catch (error) {
      for (const [id, delivery] of before) meta.inboundAcceptances![id]!.reportDelivery = delivery;
      throw error;
    }
    ctx["notifyInboundReportChange"]();
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
  options: {
    reviewedHistory?: boolean;
    receipt?: { summary?: string | undefined; links?: string[] | undefined } | undefined;
  } = {},
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
    if (receipt!.reportDelivery?.state === "read") continue;
    receipt!.reportDelivery = {
      ...receipt!.reportDelivery!,
      state: "read",
      ...(!options.reviewedHistory ? { senderNotifications: true } : {}),
      readAt: new Date().toISOString(),
      ...(options.receipt === undefined ? {} : { acknowledgment: options.receipt }),
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
  if (receipt.reportDelivery?.state === "read" && stage !== "responded") return true;
  const before = receipt.reportDelivery;
  const state =
    before?.state === "read"
      ? "read"
      : stage === "unavailable" || stage === "rejected"
        ? "pending"
        : stage === "uncertain" || stage === "expired"
          ? "uncertain"
          : "delivered";
  receipt.reportDelivery = {
    ...before,
    state,
    stage,
    ...(["consumed", "responded"].includes(stage)
      ? { takenAt: before?.takenAt ?? new Date().toISOString() }
      : {}),
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

/** Sender events are retained with the original acceptance, independently of a live bridge. */
export function senderReportEvents(
  ctx: ConversationStore,
  paneId: string,
  binding: string,
): OperatorSeatEvent[] {
  return inboundReports(ctx, undefined, { includeRead: true })
    .flatMap((report) => {
      const delivery = report.reportDelivery;
      if (report.paneId !== paneId || report.binding !== binding || !delivery.senderNotifications) return [];
      const takenAt =
        delivery.takenAt ??
        delivery.offeredAt ??
        (["consumed", "responded"].includes(delivery.stage ?? "") ? delivery.deliveredAt : undefined);
      const stages = [
        ["stored", report.acceptedAt],
        ["taken", takenAt],
        ["acknowledged", delivery.readAt],
      ] as const;
      return stages.flatMap(([stage, at]) => {
        if (!at || delivery.senderEventAcks?.includes(stage)) return [];
        const receipt = delivery.acknowledgment;
        const content =
          stage === "acknowledged"
            ? `Clankie acknowledged report ${report.deliveryId}.${receipt?.summary ? ` ${receipt.summary}` : ""}${receipt?.links?.length ? `\n${receipt.links.join("\n")}` : ""}`
            : `Report ${report.deliveryId}: ${stage === "stored" ? "stored" : "taken into a lead turn"}.`;
        return [
          {
            schemaVersion: 1 as const,
            id: `report:${report.deliveryId}:${stage}`,
            kind: "message" as const,
            conversationId: report.conversationId,
            source: "worker-report-receipt",
            content: `${content}\nReceipt only; no reply needed.`,
            createdAt: at,
          },
        ];
      });
    })
    .slice(0, 64);
}

/** Transport acknowledgment only: it never acknowledges the report on the lead's behalf. */
export function acknowledgeSenderReportEvent(
  ctx: ConversationStore,
  paneId: string,
  binding: string,
  eventId: string,
): boolean {
  const match = /^report:([a-f0-9-]{36}):(stored|taken|acknowledged)$/u.exec(eventId);
  if (!match) return false;
  const meta = [...ctx["metas"].values()].find((entry) => entry.inboundAcceptances?.[match[1]!]);
  const report = meta?.inboundAcceptances?.[match[1]!];
  if (!meta || !report || report.paneId !== paneId || report.binding !== binding) return false;
  const stage = match[2] as "stored" | "taken" | "acknowledged";
  if (report.reportDelivery?.senderEventAcks?.includes(stage)) return true;
  if (!senderReportEvents(ctx, paneId, binding).some((event) => event.id === eventId)) return false;
  const previous = report.reportDelivery;
  report.reportDelivery = { ...previous!, senderEventAcks: [...(previous?.senderEventAcks ?? []), stage] };
  try {
    ctx["saveMeta"](meta);
  } catch (error) {
    report.reportDelivery = previous;
    throw error;
  }
  return true;
}
