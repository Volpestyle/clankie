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
export const EVIDENCE_RECENT_PATH = `${EVIDENCE_ROOT_PATH}/recent`;
export const EVIDENCE_PREVIEW_PATH = `${EVIDENCE_ROOT_PATH}/preview`;
export const EVIDENCE_PREVIEW_MAX_BYTES = 64 * 1024;
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
    project: SingleLine(256).optional(),
    repo: SingleLine(1024).optional(),
    model: SingleLine(256).optional(),
    outcome: z.enum(["passed", "failed", "partial"]).optional(),
    caption: z.string().trim().min(1).max(4000).optional(),
  })
  .strict();
export type EvidenceUploadRequest = z.infer<typeof EvidenceUploadRequestSchema>;

export const EvidenceActorSchema = z
  .object({
    kind: z.enum(["operator", "worker", "seat"]),
    id: z.string().min(1),
    name: SingleLine(256).optional(),
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
    project: z.string().optional(),
    repo: z.string().optional(),
    model: z.string().optional(),
    outcome: z.enum(["passed", "failed", "partial"]).optional(),
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

/** Cursor is an opaque (createdAt,id) key; filters must stay the same between pages. */
export const EvidenceRecentQuerySchema = z
  .object({
    project: SingleLine(256).optional(),
    repo: SingleLine(1024).optional(),
    issue: SingleLine(64).optional(),
    actorKind: EvidenceActorSchema.shape.kind.optional(),
    actorName: SingleLine(256).optional(),
    mediaType: SingleLine(127).optional(),
    since: z.iso.datetime().optional(),
    until: z.iso.datetime().optional(),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(40),
  })
  .strict()
  .refine((q) => !q.since || !q.until || q.since <= q.until, "since must precede until");
export type EvidenceRecentQuery = z.infer<typeof EvidenceRecentQuerySchema>;
export const EvidenceRecentResponseSchema = z
  .object({
    records: z.array(EvidenceRecordSchema),
    nextCursor: z.string().optional(),
  })
  .strict();
export type EvidenceRecentResponse = z.infer<typeof EvidenceRecentResponseSchema>;
/**
 * What a paired device may see of one recorded blob (VUH-1936): a small image
 * as base64, or small UTF-8 text (a log, a JSON proof) as text. Anything
 * larger, or binary, is unavailable with a reason; devices never get a link
 * to the service's own origin.
 */
export const EvidenceDevicePreviewSchema = z
  .object({
    sha256: EvidenceSha256Schema,
    available: z.boolean(),
    contentType: z.string().max(127).optional(),
    data: z
      .string()
      .max(Math.ceil((EVIDENCE_PREVIEW_MAX_BYTES * 4) / 3) + 4)
      .optional(),
    text: z.string().max(EVIDENCE_PREVIEW_MAX_BYTES).optional(),
    reason: z.enum(["too_large", "not_previewable"]).optional(),
  })
  .strict();
export type EvidenceDevicePreview = z.infer<typeof EvidenceDevicePreviewSchema>;

/** Images at or below the cap only; larger images return unavailable, never partial image bytes. */
export const EvidencePreviewResponseSchema = z
  .object({
    sha256: EvidenceSha256Schema,
    available: z.boolean(),
    contentType: z.string().optional(),
    data: z.string().optional(),
    reason: z.enum(["too_large", "not_image"]).optional(),
  })
  .strict();

/**
 * Extract tracker identifiers from branch names, READMEs and historical strings.
 * A built-in item's key (`LOCAL-n`, or `LOCAL-VUH-n` once its store holds an
 * imported team) is one key, never its `VUH-n` tail: that is a different item
 * (VUH-1991). Imported items keep their tracker's own `VUH-n`.
 *
 * With `teams`, only the built-in tracker's `LOCAL-…` keys and keys whose prefix
 * is one of those tracker team keys count; `SHA-256`, `UTF-8` or `GPT-6` are not
 * work (VUH-1997). Without it, every key-shaped token counts, which only an
 * explicit `--issue` string should rely on.
 */
export function evidenceIssueKeys(text: string, teams?: readonly string[]): string[] {
  const allowed = teams?.map((team) => team.toUpperCase());
  return [
    ...new Set(
      Array.from(text.matchAll(/\b(local-[a-z0-9]+-\d+|[a-z][a-z0-9]*-\d+)\b/giu), (match) =>
        match[1]!.toUpperCase(),
      ).filter(
        (key) =>
          allowed === undefined ||
          key.startsWith("LOCAL-") ||
          allowed.includes(key.slice(0, key.lastIndexOf("-"))),
      ),
    ),
  ];
}

/** Lines that name the work a folder tracks: a heading, or a `Tracks:`/`Issue:` line. */
const EXPLICIT_LINE = /^\s*(?:#{1,6}\s|(?:[-*]\s+)?(?:\*\*|__)?(?:tracks|tracking|issues?)\b)/iu;
const ISSUE_URL = /https?:\/\/linear\.app\/[^/\s]+\/issue\/([a-z][a-z0-9]*-\d+)/giu;

/**
 * A README's issue keys under the same team rule, preferring explicit references:
 * Linear issue URLs, headings and `Tracks:`/`Issue:` lines. Only when none of
 * those names a key does a team key anywhere in the text count (VUH-1997).
 */
export function evidenceReadmeIssueKeys(text: string, teams: readonly string[]): string[] {
  const explicit = [
    ...Array.from(text.matchAll(ISSUE_URL), (match) => match[1]!),
    ...text.split("\n").filter((line) => EXPLICIT_LINE.test(line)),
  ].join("\n");
  const keys = evidenceIssueKeys(explicit, teams);
  return keys.length ? keys : evidenceIssueKeys(text, teams);
}

/** Preserve explicit non-tracker keys accepted by the original wire contract. */
export function splitEvidenceIssueKeys(text: string | undefined): string[] {
  if (text === undefined) return [];
  const keys = evidenceIssueKeys(text);
  return keys.length
    ? keys
    : [
        ...new Set(
          text
            .trim()
            .split(/[\s,;]+/u)
            .filter(Boolean)
            .map((key) => key.toUpperCase()),
        ),
      ];
}

/** Bounded bytes over the authenticated device relay, never a reusable service URL. */
export const EVIDENCE_DEVICE_CHUNK_MAX = 256 * 1024;
export const EvidenceDeviceFetchRequestSchema = z
  .object({
    sha256: EvidenceSha256Schema,
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    length: z.number().int().min(1).max(EVIDENCE_DEVICE_CHUNK_MAX),
  })
  .strict();
export type EvidenceDeviceFetchRequest = z.infer<typeof EvidenceDeviceFetchRequestSchema>;
export const EvidenceDeviceFetchSchema = z
  .object({
    sha256: EvidenceSha256Schema,
    offset: z.number().int().min(0),
    size: z.number().int().min(0),
    contentType: z.string().min(1).max(127),
    data: z.string().max(Math.ceil(EVIDENCE_DEVICE_CHUNK_MAX / 3) * 4),
  })
  .strict();
export type EvidenceDeviceFetch = z.infer<typeof EvidenceDeviceFetchSchema>;
