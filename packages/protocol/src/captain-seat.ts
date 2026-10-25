import { z } from "zod";

export const CAPTAIN_SEAT_PATH = "/v1/captain/seat";
export const CAPTAIN_SEAT_START_PATH = "/v1/captain/seat/start";
export const CAPTAIN_SEAT_STATUS_PATH = "/v1/captain/seat/status";
export const CaptainSeatSchema = z.enum(["app", "claude", "codex"]);
export type CaptainSeat = z.infer<typeof CaptainSeatSchema>;
export const CaptainSeatSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.string().min(1),
    seat: CaptainSeatSchema,
    supported: z.boolean(),
  })
  .strict();
export type CaptainSeatSnapshot = z.infer<typeof CaptainSeatSnapshotSchema>;
export const UpdateCaptainSeatSchema = z
  .object({
    expectedRevision: z.string().min(1),
    seat: CaptainSeatSchema,
  })
  .strict();
export const StartCaptainSeatSchema = z
  .object({
    expectedRevision: z.string().min(1),
    requestId: z.uuid(),
  })
  .strict();
export const CaptainSeatStatusRequestSchema = z.object({ requestId: z.uuid() }).strict();
/** A created pane is only starting. Ready means the requested native bridge has bound. */
export const CaptainSeatStartResultSchema = z
  .object({
    requestId: z.uuid(),
    seat: CaptainSeatSchema,
    conversationId: z.string().min(1).optional(),
    outcome: z.enum(["starting", "ready", "failed", "uncertain"]),
    paneId: z.string().min(1).optional(),
    error: z
      .enum(["not_ready", "unavailable", "authority_revoked", "selection_changed", "launch_unconfirmed"])
      .optional(),
  })
  .strict();
export type CaptainSeatStartResult = z.infer<typeof CaptainSeatStartResultSchema>;
