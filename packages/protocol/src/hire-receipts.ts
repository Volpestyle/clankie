import { z } from "zod";

/** Evidence is authored by the service over its configured, authenticated SSH transport. */
export const HireNoLaunchEvidenceSchema = z
  .object({
    receiptId: z.string().uuid(),
    receiptKey: z.string().min(1).max(8192),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    target: z
      .object({
        fleet: z.string(),
        host: z.string(),
        session: z.string(),
        shell: z.enum(["posix", "powershell"]),
      })
      .strict(),
    hostIdentity: z.string().min(1),
    window: z
      .object({ openedAt: z.number().int().nonnegative(), sealedAt: z.number().int().nonnegative() })
      .strict(),
    census: z
      .object({
        observedAt: z.number().int().nonnegative(),
        panes: z.number().int().nonnegative(),
        processes: z.number().int().positive(),
        sessions: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    journal: z.literal("reserved-to-sealed-without-launch"),
  })
  .strict();
export type HireNoLaunchEvidence = z.infer<typeof HireNoLaunchEvidenceSchema>;

export const HireReceiptSettlementSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("settled-not-launched"),
      receiptId: z.string().uuid(),
      evidence: HireNoLaunchEvidenceSchema,
    })
    .strict(),
  z.object({ state: z.literal("refused"), receiptId: z.string().uuid(), detail: z.string() }).strict(),
]);
export type HireReceiptSettlement = z.infer<typeof HireReceiptSettlementSchema>;
