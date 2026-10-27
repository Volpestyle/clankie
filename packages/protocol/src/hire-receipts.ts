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
    /** never-reserved: the host has no journal for the claim and no pane in its directory (VUH-2920). */
    journal: z.enum(["reserved-to-sealed-without-launch", "never-reserved"]),
  })
  .strict();
export type HireNoLaunchEvidence = z.infer<typeof HireNoLaunchEvidenceSchema>;

export const HireReceiptIdSchema = z
  .string()
  .regex(/^(?:seat-)?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
/** Historical delivery and explicit abandonment do not assert a no-launch window. */
export const HireRecoveryEvidenceSchema = HireNoLaunchEvidenceSchema.omit({ window: true, journal: true })
  .extend({
    disposition: z.enum(["delivered", "abandoned", "abandoned-unknown"]),
    journal: z.literal("authenticated-recovery"),
    allocation: z.union([
      z
        .object({
          paneId: z.string(),
          present: z.boolean(),
          terminalId: z.string().optional(),
          sessionId: z.string().optional(),
          status: z.string().optional(),
        })
        .strict(),
      z
        .object({
          outcome: z.literal("unknown"),
          launchHistory: z.enum(["launching", "uncommitted"]),
          openedAt: z.number().int().nonnegative(),
          abandonedAt: z.number().int().nonnegative(),
          freshIntentAllowed: z.literal(true),
        })
        .strict(),
    ]),
    delivery: z
      .object({
        receiptId: HireReceiptIdSchema,
        seatId: z.string(),
        sessionId: z.string().uuid(),
        entryId: z.string().uuid(),
        binding: z.enum(["historical-native-event", "original-native-binding"]),
        transcriptSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        at: z.string().datetime(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((proof, ctx) => {
    if (proof.disposition === "delivered" && !proof.delivery)
      ctx.addIssue({ code: "custom", message: "Delivered recovery needs the original native channel event" });
    const unknown = "outcome" in proof.allocation;
    if (unknown !== (proof.disposition === "abandoned-unknown") || (unknown && proof.delivery))
      ctx.addIssue({ code: "custom", message: "Unknown abandonment cannot claim an allocation or delivery" });
    if (
      "outcome" in proof.allocation &&
      (proof.allocation.abandonedAt < proof.allocation.openedAt ||
        proof.census.observedAt < proof.allocation.openedAt ||
        proof.census.observedAt > proof.allocation.abandonedAt)
    )
      ctx.addIssue({ code: "custom", message: "Unknown abandonment observation interval is invalid" });
  });
export type HireRecoveryEvidence = z.infer<typeof HireRecoveryEvidenceSchema>;
/**
 * A local hire settled from this machine's own complete Herdr inventory (VUH-2243).
 * Abandonment proves only that no harness occupies the original pane now; it
 * never claims the hire launched, never launched, or received its brief.
 * Adoption binds the harness observed in the hire's own pane to its hiring
 * conversation; it still never claims the brief arrived.
 */
export const LocalHireSettlementEvidenceSchema = z
  .object({
    receiptId: z.string().uuid(),
    receiptKey: z.string().min(1).max(8192),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    disposition: z.enum(["abandoned", "adopted"]),
    journal: z.literal("local-host-inventory"),
    census: z
      .object({
        observedAt: z.number().int().nonnegative(),
        panes: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    /** The original pane, absent or holding only its own shell. Missing when no pane was recorded. */
    pane: z
      .union([
        z.object({ paneId: z.string().min(1), present: z.literal(false) }).strict(),
        z
          .object({
            paneId: z.string().min(1),
            present: z.literal(true),
            terminalId: z.string().min(1),
            shellPid: z.number().int().positive(),
          })
          .strict(),
        z
          .object({
            paneId: z.string().min(1),
            present: z.literal(true),
            terminalId: z.string().min(1),
            occupantId: z.string().min(1),
            sessionId: z.string().min(1).optional(),
            owner: z.object({ conversationId: z.string().min(1) }).strict(),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict()
  .refine(
    (proof) => (proof.disposition === "adopted") === (proof.pane !== undefined && "occupantId" in proof.pane),
    "Only adoption names an occupant, and adoption always does",
  );
export type LocalHireSettlementEvidence = z.infer<typeof LocalHireSettlementEvidenceSchema>;
export const RetainedHireEvidenceSchema = z.union([
  HireNoLaunchEvidenceSchema,
  HireRecoveryEvidenceSchema,
  LocalHireSettlementEvidenceSchema,
]);
export type RetainedHireEvidence = z.infer<typeof RetainedHireEvidenceSchema>;
export const HireReceiptSettlementSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("allocation-released"),
      receiptId: HireReceiptIdSchema,
      fleet: z.string(),
      workingDirectory: z.string(),
      detail: z.string(),
    })
    .strict(),
  z
    .object({
      state: z.literal("settled-not-launched"),
      receiptId: HireReceiptIdSchema,
      evidence: HireNoLaunchEvidenceSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("settled-delivered"),
      receiptId: HireReceiptIdSchema,
      evidence: HireRecoveryEvidenceSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("abandoned"),
      receiptId: HireReceiptIdSchema,
      evidence: z.union([HireRecoveryEvidenceSchema, LocalHireSettlementEvidenceSchema]),
    })
    .strict(),
  z
    .object({
      state: z.literal("adopted"),
      receiptId: HireReceiptIdSchema,
      seat: z
        .object({
          paneId: z.string(),
          seatId: z.string(),
          occupantId: z.string(),
          sessionId: z.string().optional(),
        })
        .strict(),
      owner: z.object({ conversationId: z.string() }).strict(),
      /** The project allocation confirmed by this adoption, when the hire had one. */
      allocationId: z.string().uuid().optional(),
      /** The original native receipt's settlement, when the hire retained one. */
      evidence: LocalHireSettlementEvidenceSchema.optional(),
      detail: z.string(),
    })
    .strict(),
  z.object({ state: z.literal("refused"), receiptId: HireReceiptIdSchema, detail: z.string() }).strict(),
]);
export type HireReceiptSettlement = z.infer<typeof HireReceiptSettlementSchema>;
