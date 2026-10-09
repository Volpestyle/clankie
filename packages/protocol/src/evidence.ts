import { z } from "zod";

/**
 * The evidence store's wire contract (ADR 0258). Blobs are named by their
 * sha256; records describe who produced which bytes for which issue and
 * commit. Manifests in git carry only the `clankie://evidence` links.
 */
export const EVIDENCE_ROOT_PATH = "/v1/evidence";
export const EVIDENCE_UPLOADS_PATH = `${EVIDENCE_ROOT_PATH}/uploads`;
export const EVIDENCE_RECEIPTS_PATH = `${EVIDENCE_ROOT_PATH}/receipts`;
export const EVIDENCE_FETCH_PATH = `${EVIDENCE_ROOT_PATH}/fetch`;
export const EVIDENCE_RECORDS_PATH = `${EVIDENCE_ROOT_PATH}/records`;
export const EVIDENCE_STATUS_PATH = `${EVIDENCE_ROOT_PATH}/status`;
/** Signed links never outlive this; the store may choose shorter. */
export const EVIDENCE_SIGNED_URL_MAX_MS = 15 * 60_000;
export const EVIDENCE_LINK_PREFIX = "clankie://evidence/sha256/";

export const EvidenceSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u, "64 lowercase hex");

const SingleLine = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !/[\r\n]/u.test(value), "single line");

export const EvidenceUploadRequestSchema = z
  .object({
    /** Chosen by the client; the same key always answers with the same receipt. */
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u),
    sha256: EvidenceSha256Schema,
    size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    contentType: z
      .string()
      .max(127)
      .regex(/^[\w.+-]+\/[\w.+-]+$/u),
    fileName: SingleLine(1024),
    issueKey: SingleLine(64).optional(),
    commit: z
      .string()
      .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/u)
      .optional(),
    caption: z.string().trim().min(1).max(4000).optional(),
  })
  .strict();
export type EvidenceUploadRequest = z.infer<typeof EvidenceUploadRequestSchema>;

export const EvidenceActorSchema = z
  .object({
    kind: z.enum(["operator", "worker", "seat"]),
    id: z.string().min(1),
    /** Outermost principal first; empty when the actor acts for itself. */
    onBehalfOf: z.array(z.object({ kind: z.string().min(1), id: z.string().min(1) }).strict()),
  })
  .strict();
export type EvidenceActor = z.infer<typeof EvidenceActorSchema>;

export const EvidenceRecordSchema = z
  .object({
    id: z.string().uuid(),
    fileName: z.string(),
    sha256: EvidenceSha256Schema,
    size: z.number().int().min(0),
    contentType: z.string(),
    issueKey: z.string().optional(),
    commit: z.string().optional(),
    actor: EvidenceActorSchema,
    caption: z.string().optional(),
    createdAt: z.string(),
    url: z.string(),
  })
  .strict();
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

export const EvidenceReceiptSchema = z
  .object({
    receiptId: z.string(),
    state: z.enum(["applied", "pending", "refused"]),
    sha256: EvidenceSha256Schema,
    size: z.number().int().min(0),
    url: z.string(),
    recordId: z.string().uuid().optional(),
    /** Only while pending: the blob is missing and may be sent here, unauthenticated, until it expires. */
    uploadUrl: z.string().optional(),
    uploadExpiresAt: z.string().optional(),
    refusal: z.enum(["sha256_mismatch", "size_mismatch"]).optional(),
  })
  .strict();
export type EvidenceReceipt = z.infer<typeof EvidenceReceiptSchema>;

export const EvidenceFetchRequestSchema = z.object({ sha256: EvidenceSha256Schema }).strict();
export const EvidenceFetchResponseSchema = z
  .object({
    sha256: EvidenceSha256Schema,
    size: z.number().int().min(0),
    url: z.string(),
    expiresAt: z.string(),
  })
  .strict();
export type EvidenceFetchResponse = z.infer<typeof EvidenceFetchResponseSchema>;

export const EvidenceRecordListSchema = z.object({ records: z.array(EvidenceRecordSchema) }).strict();

export const EvidenceStoreStatusSchema = z
  .object({
    blobs: z.object({ backend: z.string(), location: z.string() }).strict(),
    metadata: z.object({ backend: z.string(), location: z.string() }).strict(),
  })
  .strict();
export type EvidenceStoreStatus = z.infer<typeof EvidenceStoreStatusSchema>;

/** One manifest entry; `path` is relative to the manifest and uses `/`. */
export const EvidenceManifestObjectSchema = z
  .object({
    path: z.string().min(1),
    size: z.number().int().min(0),
    sha256: EvidenceSha256Schema,
    url: z.string(),
  })
  .strict();
export type EvidenceManifestObject = z.infer<typeof EvidenceManifestObjectSchema>;
export const EvidenceManifestSchema = z
  .object({ version: z.literal(1), objects: z.array(EvidenceManifestObjectSchema) })
  .strict();
export type EvidenceManifest = z.infer<typeof EvidenceManifestSchema>;

export function evidenceLink(sha256: string): string {
  return `${EVIDENCE_LINK_PREFIX}${sha256}`;
}
