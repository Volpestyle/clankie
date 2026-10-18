import { z } from "zod";
import { HireNoLaunchEvidenceSchema } from "@clankie/protocol";
import { ProjectHireProcessProofSchema } from "./project-hires.ts";

/** Retirement-only evidence. It never replaces launch provenance or grants native control. */
export const RestoredHireRetirementSchema = z
  .object({
    receiptId: z.string().min(1),
    originalSeatId: z.string().min(1),
    target: HireNoLaunchEvidenceSchema.shape.target,
    observedAt: z.string().datetime(),
    censusSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    proof: ProjectHireProcessProofSchema,
  })
  .strict();

export type RetirementGuard = (() => Promise<void>) & {
  restoredHire?: z.infer<typeof RestoredHireRetirementSchema>;
};
