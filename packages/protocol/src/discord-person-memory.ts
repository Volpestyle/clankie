import { z } from "zod";

// ---------------------------------------------------------------------------
// Discord person memory (ADR 0042).
//
// This is the one public wire contract shared by Discord ingress, the control
// plane, API clients, and storage. It deliberately carries stable Discord ids
// and bounded approved facts, never display names or raw transcript content.
// ---------------------------------------------------------------------------

export const DiscordPersonIdentitySchema = z
  .object({
    guildId: z.string().trim().min(1).max(64),
    userId: z.string().trim().min(1).max(64),
  })
  .strict();
export type DiscordPersonIdentity = z.infer<typeof DiscordPersonIdentitySchema>;

export const DiscordPersonMemoryKindSchema = z.enum(["person-fact", "preference", "relationship-note"]);
export type DiscordPersonMemoryKind = z.infer<typeof DiscordPersonMemoryKindSchema>;

export const DiscordPersonMemoryVisibilitySchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("guild") }).strict(),
  z.object({ scope: z.literal("channel"), channelId: z.string().trim().min(1).max(64) }).strict(),
  z.object({ scope: z.literal("operator_private") }).strict(),
]);
export type DiscordPersonMemoryVisibility = z.infer<typeof DiscordPersonMemoryVisibilitySchema>;

export const DiscordPersonMemoryFactSchema = z
  .object({
    schemaVersion: z.literal(1),
    factId: z.string().trim().min(1).max(256),
    subject: DiscordPersonIdentitySchema,
    kind: DiscordPersonMemoryKindSchema,
    body: z.string().trim().min(1).max(2_048),
    visibility: DiscordPersonMemoryVisibilitySchema,
    provenance: z
      .object({
        correlationId: z.string().trim().min(1).max(256),
        sourceEventId: z.string().trim().min(1).max(256),
        sourceSurface: z.enum(["discord_text", "discord_voice", "operator"]),
        rawTranscript: z.literal(false),
      })
      .strict(),
    confidence: z.number().min(0).max(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    expiresAt: z.string().datetime().optional(),
    supersedesFactId: z.string().trim().min(1).max(256).optional(),
  })
  .strict()
  .superRefine((fact, context) => {
    if (fact.updatedAt < fact.createdAt) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "updatedAt must not precede createdAt",
      });
    }
    if (fact.expiresAt !== undefined && fact.expiresAt <= fact.updatedAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "expiresAt must follow updatedAt",
      });
    }
    if (fact.supersedesFactId === fact.factId) {
      context.addIssue({
        code: "custom",
        path: ["supersedesFactId"],
        message: "a person-memory fact cannot supersede itself",
      });
    }
  });
export type DiscordPersonMemoryFact = z.infer<typeof DiscordPersonMemoryFactSchema>;

export const DiscordPersonMemoryProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    proposalId: z.string().trim().min(1).max(256),
    fact: DiscordPersonMemoryFactSchema,
  })
  .strict();
export type DiscordPersonMemoryProposal = z.infer<typeof DiscordPersonMemoryProposalSchema>;

export const DiscordPersonMemoryProjectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    subject: DiscordPersonIdentitySchema,
    facts: z.array(DiscordPersonMemoryFactSchema).max(128),
    recallCard: z.string().max(4_096).optional(),
  })
  .strict();
export type DiscordPersonMemoryProjection = z.infer<typeof DiscordPersonMemoryProjectionSchema>;

export const DiscordPersonMemoryExportSchema = z
  .object({
    schemaVersion: z.literal(1),
    subject: DiscordPersonIdentitySchema,
    exportedAt: z.string().datetime(),
    facts: z.array(DiscordPersonMemoryFactSchema).max(128),
  })
  .strict();
export type DiscordPersonMemoryExport = z.infer<typeof DiscordPersonMemoryExportSchema>;

export const DiscordPersonMemoryDeleteResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    subject: DiscordPersonIdentitySchema,
    deletedFactIds: z.array(z.string().trim().min(1).max(256)).max(128),
  })
  .strict();
export type DiscordPersonMemoryDeleteResult = z.infer<typeof DiscordPersonMemoryDeleteResultSchema>;

/** Authenticated owner edits preserve the fact's identity and source provenance. */
export const DiscordPersonMemoryEditSchema = z
  .object({
    body: z.string().trim().min(1).max(2_048).optional(),
    kind: DiscordPersonMemoryKindSchema.optional(),
    visibility: DiscordPersonMemoryVisibilitySchema.optional(),
    confidence: z.number().min(0).max(1).optional(),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .strict()
  .refine((edit) => Object.keys(edit).length > 0, "an edit must change at least one field");
export type DiscordPersonMemoryEdit = z.infer<typeof DiscordPersonMemoryEditSchema>;
