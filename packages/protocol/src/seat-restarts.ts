import { z } from "zod";

const SeatRestartHandoffSchema = z.object({
  id: z.string(),
  at: z.string().datetime(),
  state: z.enum(["requested", "kept", "uncertain", "restarted"]),
  failureNoticedAt: z.string().datetime().optional(),
});

export const FLEET_SEAT_RESTARTS_PATH = "/v1/fleet/seat-restarts";
export const SeatRestartStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    setting: z.enum(["on", "off"]),
    budgetTokens: z.literal(450000),
    receipts: z
      .array(
        z.object({
          id: z.string(),
          paneId: z.string(),
          previousSessionId: z.string(),
          at: z.string(),
          stage: z.string(),
          reason: z.string().optional(),
          messageId: z.string().optional(),
          sessionId: z.string().optional(),
        }),
      )
      .optional(),
    seats: z.array(
      z.object({
        paneId: z.string(),
        sessionId: z.string(),
        check: z
          .object({ at: z.string().datetime(), contextTokens: z.number().int().nonnegative().optional() })
          .optional(),
        waiting: z
          .object({
            since: z.string().datetime(),
            lastAt: z.string().datetime(),
            reason: z.string(),
            detail: z.string().optional(),
            counts: z.record(z.string(), z.number().int().positive()),
            noticedAt: z.string().datetime().optional(),
          })
          .optional(),
        handoff: SeatRestartHandoffSchema.optional(),
        handoffHistory: z
          .array(
            SeatRestartHandoffSchema.extend({
              retiredAt: z.string().datetime(),
              reason: z.literal("handoff_superseded"),
              receiptId: z.string().optional(),
            }),
          )
          .optional(),
        receiptId: z.string().optional(),
      }),
    ),
  })
  .strict();
export type SeatRestartStatus = z.infer<typeof SeatRestartStatusSchema>;
