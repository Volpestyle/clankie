import { DeliveryStageSchema, WorkerReportRoutingSchema } from "@clankie/protocol";
import { z } from "zod";
import { ConversationOwnerSchema, NativeSeatRecipientSchema } from "../conversation-owner.ts";

export const CURSOR_WIDTH = 12;

export const ZERO_CURSOR = "0".repeat(CURSOR_WIDTH);

/** A maximum-length report can expand to six JSON bytes per UTF-16 unit. */
export const WORKER_REPORT_PAGE_BYTES = 128 * 1024;

export const LINEAR_WAKE_EVENTS_MAX = 40;

export const LINEAR_BURST_WINDOW_MS = 1_500;

export const LINEAR_REPLAY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/** Under the relay's 30s upstream dispatch timeout, with headroom. */
export const DEFAULT_TAIL_WAIT_MS = 25_000;

export const OPERATOR_CONVERSATION_RETAINED_MAX = 64;

export const OPERATOR_CONVERSATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export const OPERATOR_CONVERSATION_RETAINED_BYTES_MAX = 256 * 1024 * 1024;

export const OPERATOR_CONVERSATION_RETAINED_EVENTS_MAX = 500;

export const OPERATOR_CONVERSATION_RETAINED_EVENTS_AFTER_TRIM = 400;

export const SEAT_CONVERSATION_RETAINED_EVENTS_MAX = 10_000;

export const SEAT_CONVERSATION_RETAINED_EVENTS_AFTER_TRIM = 9_000;

/**
 * How long one member's turn may hold up the round before it counts as a pass.
 * A member that never answers must not wedge the room: the operator is waiting
 * on the whole round, not on any one seat.
 */
export const CHANNEL_TURN_TIMEOUT_MS = 5 * 60 * 1_000;

export const InboundReportDeliverySchema = z
  .object({
    state: z.enum(["pending", "attempting", "delivered", "uncertain", "read"]),
    stage: DeliveryStageSchema.optional(),
    attemptedAt: z.string().datetime().optional(),
    deliveredAt: z.string().datetime().optional(),
    offeredAt: z.string().datetime().optional(),
    readAt: z.string().datetime().optional(),
  })
  .strict();

/** Captured by the host at admission; a worker cannot choose its recipient. */
export const InboundReportRecipientSchema = z.union([
  NativeSeatRecipientSchema,
  z.object({ kind: z.literal("conversation"), owner: ConversationOwnerSchema }).strict(),
]);

export const InboundAcceptanceSchema = z
  .object({
    deliveryId: z.string().uuid(),
    binding: z.string(),
    fingerprint: z.string(),
    paneId: z.string(),
    text: z.string(),
    message: z.string(),
    runId: z.string(),
    acceptedCursor: z.string(),
    workerReportRouting: WorkerReportRoutingSchema.optional(),
    recipient: InboundReportRecipientSchema.optional(),
    acceptedAt: z.string().datetime().optional(),
    reportDelivery: InboundReportDeliverySchema.optional(),
  })
  .strict();
