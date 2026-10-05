import { z } from "zod";

/** Durable worker output remains visible independently of its pane's lifetime. */
export const WorkerReportSummarySchema = z
  .object({
    deliveryId: z.string().uuid(),
    conversationId: z.string().min(1).max(256),
    paneId: z.string().min(1).max(256),
    acceptedAt: z.string(),
    state: z.enum(["pending", "attempting", "delivered", "uncertain", "read"]),
    stage: z.string().optional(),
  })
  .strict();
export type WorkerReportSummary = z.infer<typeof WorkerReportSummarySchema>;

export const WorkerReportPageSchema = z
  .object({
    conversationId: z.string().min(1).max(256),
    unreadCount: z.number().int().min(0),
    items: z.array(WorkerReportSummarySchema.extend({ text: z.string() })).max(100),
    /** Only these fully offered IDs may be acknowledged. Reading never acknowledges. */
    ackDeliveryIds: z.array(z.string().uuid()).max(100),
  })
  .strict();
export type WorkerReportPage = z.infer<typeof WorkerReportPageSchema>;
