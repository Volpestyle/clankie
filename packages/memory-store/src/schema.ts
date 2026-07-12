import { z } from "zod";

export const MEMORY_FACT_SCHEMA_VERSION = 1 as const;
export const MemoryCategorySchema = z.enum([
  "owner-preference",
  "repo-knowledge",
  "mission-lesson",
  "entity-fact",
]);
export type MemoryCategory = z.infer<typeof MemoryCategorySchema>;

export const MemoryProvenanceSchema = z
  .object({
    missionId: z.string().min(1).max(256),
    correlationId: z.string().min(1).max(256),
    sourceEventId: z.string().min(1).max(256),
    sourceKind: z.enum(["semantic-event", "raw-transcript"]).default("semantic-event"),
    publicSource: z.boolean().default(false),
  })
  .strict();

export const MemoryFactSchema = z
  .object({
    schemaVersion: z.literal(MEMORY_FACT_SCHEMA_VERSION),
    factId: z.string().min(1).max(256),
    category: MemoryCategorySchema,
    body: z.string().trim().min(1).max(2_048),
    provenance: MemoryProvenanceSchema,
    confidence: z.number().min(0).max(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .refine((fact) => fact.updatedAt >= fact.createdAt, {
    path: ["updatedAt"],
    message: "updatedAt must not precede createdAt",
  });
export type MemoryFact = z.infer<typeof MemoryFactSchema>;

export const ApprovedMemoryProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    proposalId: z.string().min(1).max(256),
    approval: z
      .object({
        approvalId: z.string().min(1).max(256),
        status: z.literal("approved"),
        approvedAt: z.string().datetime(),
        approvedBy: z.string().min(1).max(256),
      })
      .strict(),
    fact: MemoryFactSchema,
  })
  .strict();
export type ApprovedMemoryProposal = z.infer<typeof ApprovedMemoryProposalSchema>;

export interface MemoryDoctrine {
  readonly rawTranscriptRetentionDays: number;
  readonly publicToPrivatePropagation: boolean;
}
