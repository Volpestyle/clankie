import { z } from "zod";

/**
 * Owner settlement of a seat-mailbox delivery whose receipt never resolved
 * (VUH-1779). It records that nobody knows whether the event landed: it never
 * claims receipt and never authorizes resending that original.
 */
export const SeatDeliveryAbandonmentSchema = z
  .object({
    disposition: z.literal("abandoned-unknown"),
    journal: z.literal("owner-settled-unknown"),
    receiptId: z.string().min(1).max(256),
    fingerprint: z.string(),
    /** Absent for receipts recorded before VUH-1779. */
    beganAt: z.number().int().nonnegative().optional(),
    abandonedAt: z.number().int().nonnegative(),
  })
  .strict();
export type SeatDeliveryAbandonment = z.infer<typeof SeatDeliveryAbandonmentSchema>;

export const UnresolvedSeatDeliverySchema = z
  .object({
    conversationId: z.string().min(1),
    receiptId: z.string().min(1),
    /** Absent for receipts recorded before VUH-1779; their age is unknown. */
    beganAt: z.number().int().nonnegative().optional(),
    ageMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type UnresolvedSeatDelivery = z.infer<typeof UnresolvedSeatDeliverySchema>;

export const SeatDeliverySettlementSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("abandoned-unknown"),
      conversationId: z.string().min(1),
      receiptId: z.string().min(1),
      evidence: SeatDeliveryAbandonmentSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("refused"),
      conversationId: z.string().min(1),
      receiptId: z.string().min(1),
      detail: z.string(),
    })
    .strict(),
]);
export type SeatDeliverySettlement = z.infer<typeof SeatDeliverySettlementSchema>;
