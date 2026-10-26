import { z } from "zod";

export const EVIDENCE_EXCHANGE_WINDOW_MS = 5 * 60_000;
export const EVIDENCE_ISSUER_PATH = "/fleet/v1/body/evidence-session";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
export const EvidenceSessionBindingSchema = z
  .object({
    audience: z.literal("evidence-storage"),
    tenantId: id,
    installationId: id,
    bodyKeyId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    encryptionKeyId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    destinationId: id,
    bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u),
    region: z.string().regex(/^[a-z0-9-]{1,64}$/u),
    prefix: z
      .string()
      .regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u)
      .max(512),
    purpose: z.enum(["read", "write"]),
    revision: z.number().int().positive(),
  })
  .strict();
export type EvidenceSessionBinding = z.infer<typeof EvidenceSessionBindingSchema>;

/** The wire selects only an opaque destination and purpose, never cloud policy. */
export const EvidenceSessionRequestSchema = z
  .object({
    destinationId: id,
    purpose: z.enum(["read", "write"]),
  })
  .strict();
export const EvidenceSessionSchema = z
  .object({
    accessKeyId: z.string().min(1).max(256),
    secretAccessKey: z.string().min(1).max(4096),
    sessionToken: z.string().min(1).max(16384),
  })
  .strict();
export type EvidenceSession = z.infer<typeof EvidenceSessionSchema>;
export const EvidenceLeaseSchema = z
  .object({
    binding: EvidenceSessionBindingSchema,
    nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
    issuedAtMs: z.number().int().positive(),
    expiresAtMs: z.number().int().positive(),
    session: EvidenceSessionSchema,
  })
  .strict();
export type EvidenceLease = z.infer<typeof EvidenceLeaseSchema>;
