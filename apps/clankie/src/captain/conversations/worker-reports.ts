import { ConversationCommitError } from "./errors.ts";
import {
  WorkerReportSummarySchema,
  type DeliveryStage,
  type OperatorSeatEvent,
  type SubmitOperatorConversationTurnResult,
  type WorkerReportPage,
  type WorkerReportSummary,
} from "@clankie/protocol";
import { z } from "zod";
import { InboundAcceptanceSchema, READ_REPORT_RETENTION_MS, WORKER_REPORT_PAGE_BYTES } from "./constants.ts";
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

/**
 * Drops reports read more than a day ago before the metadata is written
 * (VUH-2410). Each save rewrote every report ever accepted, which made the
 * default conversation's file the service's largest garbage source. An unread
 * report is never dropped, and a dropped report's exact-ID status reads as
 * unknown, which never claims it was not sent.
 */
export function retainInboundReports(meta: ConversationMeta, now: number): void {
  const acceptances = meta.inboundAcceptances;
  if (acceptances === undefined) return;
  const cutoff = now - READ_REPORT_RETENTION_MS;
  const kept = Object.entries(acceptances).filter(([, receipt]) => {
    if (receipt.reportDelivery?.state !== "read") return true;
    const readAt = Date.parse(receipt.reportDelivery.readAt ?? receipt.acceptedAt ?? "");
    return !Number.isFinite(readAt) || readAt >= cutoff;
  });
  if (kept.length === Object.keys(acceptances).length) return;
  // A fresh object: a caller restoring its pre-save snapshot after a failed write keeps every report.
  if (kept.length === 0) delete meta.inboundAcceptances;
  else meta.inboundAcceptances = Object.fromEntries(kept);
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
  options: {
    includeRead?: boolean;
    acceptedAfterMs?: number;
    sender?: { paneId: string; binding: string };
  } = {},
): InboundReport[] {
  return [...ctx["metas"].values()]
    .filter((meta) => conversationId === undefined || meta.conversationId === conversationId)
    .flatMap((meta) =>
      Object.values(meta.inboundAcceptances ?? {})
        // Select before validating: every worker poll asks for one sender's
        // reports, and parsing all retained payloads to discard them was a
        // CPU hot path (VUH-2216). Each returned report is still parsed.
        .filter(
          (value) =>
            (options.includeRead || value.reportDelivery?.state !== "read") &&
            (options.sender === undefined ||
              (value.paneId === options.sender.paneId && value.binding === options.sender.binding)) &&
            (options.acceptedAfterMs === undefined ||
              Date.parse(value.acceptedAt ?? meta.createdAt) > options.acceptedAfterMs),
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

/** Metadata cards never clone report payloads; admission and restoration validate the full receipt. */
export function inboundReportSummaries(
  ctx: ConversationStore,
  conversationId?: string,
  options: {
    includeRead?: boolean;
    acceptedAfterMs?: number;
    sender?: { paneId: string; binding: string | undefined };
  } = {},
): WorkerReportSummary[] {
  const summaries: WorkerReportSummary[] = [];
  for (const meta of ctx["metas"].values()) {
    if (conversationId !== undefined && meta.conversationId !== conversationId) continue;
    for (const receipt of Object.values(meta.inboundAcceptances ?? {})) {
      const state = receipt.reportDelivery?.state ?? "uncertain";
      const acceptedAt = receipt.acceptedAt ?? meta.createdAt;
      if (
        (!options.includeRead && state === "read") ||
        (options.acceptedAfterMs !== undefined && !(Date.parse(acceptedAt) > options.acceptedAfterMs)) ||
        (options.sender !== undefined &&
          (receipt.paneId !== options.sender.paneId || receipt.binding !== options.sender.binding))
      )
        continue;
      summaries.push(
        WorkerReportSummarySchema.parse({
          deliveryId: receipt.deliveryId,
          conversationId: meta.conversationId,
          paneId: receipt.paneId,
          acceptedAt,
          state,
          ...(receipt.reportDelivery?.stage === undefined ? {} : { stage: receipt.reportDelivery.stage }),
        }),
      );
    }
  }
  return summaries.sort(
    (a, b) => a.acceptedAt.localeCompare(b.acceptedAt) || a.deliveryId.localeCompare(b.deliveryId),
  );
}

/** Offering full, bounded payloads does not mark them read. */
export function readInboundReports(
  ctx: ConversationStore,
  conversationId: string,
  options: {
    limit?: number | undefined;
    deliveryIds?: readonly string[] | undefined;
    /** The live pane-to-seat join, so a reader can tell which agent sent each report. */
    seatIdFor?: ((paneId: string) => string | undefined) | undefined;
  } = {},
): WorkerReportPage {
  const meta = ctx["metas"].get(conversationId);
  if (!meta) throw new Error("Unknown worker-report conversation");
  const unread = ctx["inboundReports"](conversationId);
  const selectedIds = options.deliveryIds === undefined ? undefined : new Set(options.deliveryIds);
  const selected =
    selectedIds === undefined ? unread : unread.filter((report) => selectedIds.has(report.deliveryId));
  const items: WorkerReportPage["items"] = [];
  for (const report of selected.slice(
    0,
    Math.min(100, Math.max(1, options.limit ?? (selectedIds === undefined ? 20 : 100))),
  )) {
    const seatId = options.seatIdFor?.(report.paneId);
    const item = {
      deliveryId: report.deliveryId,
      conversationId,
      paneId: report.paneId,
      ...(seatId === undefined ? {} : { seatId }),
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
  if (items.length === 0 && selected.length > 0)
    throw new Error("Worker report exceeds the inbox output budget; it remains unread.");
  const now = new Date().toISOString();
  // Offering the same immutable payload again adds no new admission or take
  // evidence. Persist the first offer once; repeated inbox polls are reads.
  const changed = items.filter((report) => {
    const delivery = meta.inboundAcceptances![report.deliveryId]!.reportDelivery;
    return !delivery?.offeredAt || !delivery.takenAt || !delivery.senderNotifications;
  });
  const before = new Map(
    changed.map((report) => [report.deliveryId, meta.inboundAcceptances![report.deliveryId]!.reportDelivery]),
  );
  for (const report of changed) {
    const receipt = meta.inboundAcceptances![report.deliveryId]!;
    receipt.reportDelivery = {
      ...receipt.reportDelivery!,
      offeredAt: receipt.reportDelivery?.offeredAt ?? now,
      takenAt: receipt.reportDelivery?.takenAt ?? now,
      senderNotifications: true,
    };
  }
  if (changed.length > 0) {
    try {
      ctx["saveMeta"](meta);
    } catch (error) {
      if (!(error instanceof ConversationCommitError && error.committed))
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
  const before = new Map(receipts.map((receipt) => [receipt!.deliveryId, receipt!.reportDelivery]));
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
    if (!(error instanceof ConversationCommitError && error.committed))
      for (const [id, delivery] of before) meta.inboundAcceptances![id]!.reportDelivery = delivery;
    throw error;
  }
  ctx["notifyInboundReportChange"]();
  return true;
}

/**
 * Retires unread reports whose sending seat is gone (VUH-2806): no lead can still
 * answer them, and they buried live seats' reports. Only reports already handed to
 * the lead or of uncertain handoff qualify; a pending one is still owed a delivery.
 * The caller's audit record is written first, so a failure there changes nothing.
 * Like reviewed history, a retirement sends no acknowledgment to the gone sender.
 */
export function retireInboundReports(
  ctx: ConversationStore,
  conversationId: string,
  deliveryIds: readonly string[],
  audit: (reports: readonly InboundReport[]) => void,
): string[] {
  const meta = ctx["metas"].get(conversationId);
  const wanted = new Set(deliveryIds);
  const reports = meta
    ? ctx["inboundReports"](conversationId).filter(
        (report) =>
          wanted.has(report.deliveryId) &&
          (report.reportDelivery.state === "delivered" || report.reportDelivery.state === "uncertain"),
      )
    : [];
  if (!meta || reports.length === 0) return [];
  audit(reports);
  const before = new Map(
    reports.map((report) => [report.deliveryId, meta.inboundAcceptances![report.deliveryId]!.reportDelivery]),
  );
  const now = new Date().toISOString();
  for (const report of reports) {
    const receipt = meta.inboundAcceptances![report.deliveryId]!;
    receipt.reportDelivery = { ...receipt.reportDelivery!, state: "read", readAt: now };
  }
  try {
    ctx["saveMeta"](meta);
  } catch (error) {
    if (!(error instanceof ConversationCommitError && error.committed))
      for (const [id, delivery] of before) meta.inboundAcceptances![id]!.reportDelivery = delivery;
    throw error;
  }
  ctx["notifyInboundReportChange"]();
  return reports.map((report) => report.deliveryId);
}

/**
 * A lead message reached this worker, so its earlier reports to that lead have
 * a reply (VUH-2065). Only a delivered message counts: an answer given
 * elsewhere, such as the owner's chat, never reaches the worker.
 */
export function recordInboundReportReply(
  ctx: ConversationStore,
  conversationId: string,
  paneId: string,
  binding: string,
): void {
  const meta = ctx["metas"].get(conversationId);
  const now = new Date().toISOString();
  const replied = Object.values(meta?.inboundAcceptances ?? {}).filter(
    (receipt) =>
      receipt.paneId === paneId &&
      receipt.binding === binding &&
      receipt.reportDelivery !== undefined &&
      receipt.reportDelivery.repliedAt === undefined,
  );
  if (!meta || replied.length === 0) return;
  const before = new Map(replied.map((receipt) => [receipt.deliveryId, receipt.reportDelivery]));
  for (const receipt of replied) receipt.reportDelivery = { ...receipt.reportDelivery!, repliedAt: now };
  try {
    ctx["saveMeta"](meta);
  } catch (error) {
    if (!(error instanceof ConversationCommitError && error.committed))
      for (const [id, delivery] of before) meta.inboundAcceptances![id]!.reportDelivery = delivery;
    throw error;
  }
  ctx["notifyInboundReportChange"]();
}

/** Reports whose worker has had no reply from this conversation since sending them. */
export function unansweredInboundReports(
  ctx: ConversationStore,
  conversationId: string,
  deliveryIds: readonly string[],
): string[] {
  const acceptances = ctx["metas"].get(conversationId)?.inboundAcceptances ?? {};
  return [...new Set(deliveryIds)].filter(
    (id) => acceptances[id] !== undefined && acceptances[id].reportDelivery?.repliedAt === undefined,
  );
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
  if (
    before?.state === state &&
    before.stage === stage &&
    (!["consumed", "responded"].includes(stage) || before.takenAt !== undefined)
  )
    return true;
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
    if (!(error instanceof ConversationCommitError && error.committed)) receipt.reportDelivery = before;
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
  return inboundReports(ctx, undefined, { includeRead: true, sender: { paneId, binding } })
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
        // The lead's summary is free text and may say a question was answered.
        // Relay it only once a reply actually reached this worker (VUH-2065).
        const summary = delivery.repliedAt
          ? receipt?.summary
            ? ` ${receipt.summary}`
            : ""
          : " No reply from Clankie has reached you for it, so any question or blocker in it is still open.";
        const content =
          stage === "acknowledged"
            ? `Clankie acknowledged report ${report.deliveryId}.${summary}${receipt?.links?.length ? `\n${receipt.links.join("\n")}` : ""}`
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
