import { z } from "zod";

/**
 * What a worker's report asks of its lead (#317): `done` (finished, nothing
 * needed), `blocked` (it needs an answer before it can go on) or `update` (no
 * reply needed). Optional: an untyped report is read in full as before.
 */
export const WorkerReportKindSchema = z.enum(["done", "blocked", "update"]);
export type WorkerReportKind = z.infer<typeof WorkerReportKindSchema>;

/**
 * Whether a hire's report wakes can reach their lead (#735). `set`: a webhook is stored
 * and nothing has been sent yet. `not_set`: no webhook goes by that name, so wakes go
 * nowhere. Otherwise the outcome of the lead's latest wake this boot.
 */
export const HireNotifySchema = z
  .object({
    lead: z.string().min(1).max(32),
    state: z.enum(["set", "sent", "not_set", "refused", "uncertain", "unavailable"]),
  })
  .strict();
export type HireNotify = z.infer<typeof HireNotifySchema>;

/** Durable worker output remains visible independently of its pane's lifetime. */
export const WorkerReportSummarySchema = z
  .object({
    deliveryId: z.string().uuid(),
    conversationId: z.string().min(1).max(256),
    paneId: z.string().min(1).max(256),
    /** Current observed pane-to-seat join; absent when the pane is outside the census. */
    seatId: z.string().min(1).max(256).optional(),
    acceptedAt: z.string(),
    state: z.enum(["pending", "attempting", "delivered", "uncertain", "read"]),
    stage: z.string().optional(),
    kind: WorkerReportKindSchema.optional(),
  })
  .strict();
export type WorkerReportSummary = z.infer<typeof WorkerReportSummarySchema>;

export const WorkerReportPageSchema = z
  .object({
    conversationId: z.string().min(1).max(256),
    unreadCount: z.number().int().min(0),
    items: z
      .array(WorkerReportSummarySchema.extend({ text: z.string(), notify: HireNotifySchema.optional() }))
      .max(100),
    /** Only these fully offered IDs may be acknowledged. Reading never acknowledges. */
    ackDeliveryIds: z.array(z.string().uuid()).max(100),
  })
  .strict();
export type WorkerReportPage = z.infer<typeof WorkerReportPageSchema>;
