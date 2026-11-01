import { z } from "zod";

/**
 * One body holds Clankie at a time (ADR 0286). Owner-only routes move his
 * identity, memory, conversations, projects and tracker between bodies; the
 * self record fences every step so two bodies are never active together.
 */
export const BODY_TRANSFER_STATUS_PATH = "/v1/body-transfer/status";
export const BODY_TRANSFER_FREEZE_PATH = "/v1/body-transfer/freeze";
export const BODY_TRANSFER_BUNDLE_PATH = "/v1/body-transfer/bundle";
export const BODY_TRANSFER_STAGE_CHUNK_PATH = "/v1/body-transfer/stage-chunk";
export const BODY_TRANSFER_STAGE_PATH = "/v1/body-transfer/stage";
export const BODY_TRANSFER_APPLY_PATH = "/v1/body-transfer/apply";
export const BODY_TRANSFER_RELEASE_PATH = "/v1/body-transfer/release";
export const BODY_TRANSFER_DISCARD_PATH = "/v1/body-transfer/discard";
export const BODY_TRANSFER_ABORT_PATH = "/v1/body-transfer/abort";
export const BODY_TRANSFER_RECLAIM_PATH = "/v1/body-transfer/reclaim";
export const BODY_TRANSFER_REBIND_PATH = "/v1/body-transfer/rebind";
export const BODY_TRANSFER_FORMAT = "clankie-body-transfer/1";
/**
 * Bundles move in chunks that fit the gateway's encrypted envelope (1 MiB
 * requests, 16 MiB responses), so one protocol serves loopback and hosted bodies.
 */
export const BODY_TRANSFER_UPLOAD_CHUNK_BYTES = 384 * 1024;
export const BODY_TRANSFER_DOWNLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
/** Every transfer route, all owner-only; GET only for status. */
export const BODY_TRANSFER_ROUTES = [
  { method: "GET" as const, path: BODY_TRANSFER_STATUS_PATH },
  ...[
    BODY_TRANSFER_FREEZE_PATH,
    BODY_TRANSFER_BUNDLE_PATH,
    BODY_TRANSFER_STAGE_CHUNK_PATH,
    BODY_TRANSFER_STAGE_PATH,
    BODY_TRANSFER_APPLY_PATH,
    BODY_TRANSFER_RELEASE_PATH,
    BODY_TRANSFER_DISCARD_PATH,
    BODY_TRANSFER_ABORT_PATH,
    BODY_TRANSFER_RECLAIM_PATH,
    BODY_TRANSFER_REBIND_PATH,
  ].map((path) => ({ method: "POST" as const, path })),
] as const satisfies readonly { method: "GET" | "POST"; path: string }[];

export const BodyTransferIdSchema = z.uuid();
export const BodySelfStateSchema = z.enum(["active", "frozen", "released"]);
const PeerSchema = z.string().trim().min(1).max(512);
const AtSchema = z.iso.datetime();

/** Everything a body has done with one transfer id. Its presence fences the id. */
export const BodyTransferRecordSchema = z.strictObject({
  role: z.enum(["source", "destination"]),
  outcome: z.enum(["frozen", "released", "aborted", "staged", "applying", "applied", "burned"]),
  epoch: z.number().int().positive(),
  peer: PeerSchema,
  at: AtSchema,
  /** Source only: the destination's machine id on this body, which becomes its `local`. */
  destinationMachineId: z.string().min(1).max(200).optional(),
  /** Destination only: replace an independent history instead of refusing. */
  replace: z.boolean().optional(),
});
export type BodyTransferRecord = z.infer<typeof BodyTransferRecordSchema>;

export const BodySelfSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** Absent on a body that has only fenced ids (an unclaimed destination). */
  selfId: z.uuid().optional(),
  epoch: z.number().int().nonnegative(),
  state: BodySelfStateSchema,
  /** The transfer that put this body in its current state. */
  transferId: BodyTransferIdSchema.optional(),
  /** Where Clankie went, while released. */
  releasedTo: z
    .strictObject({ peer: PeerSchema, epoch: z.number().int().positive(), at: AtSchema })
    .optional(),
  transfers: z.record(BodyTransferIdSchema, BodyTransferRecordSchema),
});
export type BodySelf = z.infer<typeof BodySelfSchema>;

/** `/health` and the status route report this; `selfId` is absent before the first transfer. */
export const BodyAuthoritySchema = z.strictObject({
  selfId: z.uuid().optional(),
  epoch: z.number().int().nonnegative(),
  state: BodySelfStateSchema,
  dormant: z.boolean(),
  transferId: BodyTransferIdSchema.optional(),
  releasedTo: BodySelfSchema.shape.releasedTo,
  transfers: z.record(BodyTransferIdSchema, BodyTransferRecordSchema).optional(),
});
export type BodyAuthority = z.infer<typeof BodyAuthoritySchema>;

export const BodyTransferFreezeRequestSchema = z.strictObject({
  transferId: BodyTransferIdSchema,
  destination: PeerSchema,
  destinationMachineId: z.string().min(1).max(200).optional(),
});
export const BodyTransferIdRequestSchema = z.strictObject({ transferId: BodyTransferIdSchema });
export const BodyTransferReleaseRequestSchema = z.strictObject({
  transferId: BodyTransferIdSchema,
  destination: PeerSchema,
  /** What the destination reported after applying: proof it is the active body. */
  activation: BodyAuthoritySchema,
});
export const BodyTransferAbortRequestSchema = z.strictObject({
  transferId: BodyTransferIdSchema,
  /** The body that burned the id; the source accepts only the one it froze for. */
  destination: PeerSchema,
  /** What the destination reported after burning the id. */
  discarded: BodyAuthoritySchema,
});
export const BodyTransferReclaimRequestSchema = z.strictObject({
  force: z.literal(true),
  reason: z.string().trim().min(1).max(500),
});
export const BodyTransferRebindRequestSchema = z.strictObject({
  transferId: BodyTransferIdSchema,
  machineId: z.string().min(1).max(200),
});

export const BodyTransferRootSchema = z.enum(["state", "memory", "attachments"]);
const RelativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "relative path inside its root",
  );
export const BodyTransferEntrySchema = z.strictObject({
  root: BodyTransferRootSchema,
  path: RelativePathSchema,
});
export type BodyTransferEntry = z.infer<typeof BodyTransferEntrySchema>;

export const BodyTransferManifestSchema = z.strictObject({
  format: z.literal(BODY_TRANSFER_FORMAT),
  transferId: BodyTransferIdSchema,
  selfId: z.uuid(),
  epoch: z.number().int().positive(),
  source: z.strictObject({ label: PeerSchema, platform: z.enum(["posix", "windows"]), createdAt: AtSchema }),
  /** Moved top-level owner settings, workspaces already rewritten for the destination. */
  settings: z.record(z.string(), z.unknown()),
  /** Entries the destination archives and replaces, whether or not the source had them. */
  replaces: z.array(BodyTransferEntrySchema).max(256),
  files: z
    .array(
      BodyTransferEntrySchema.extend({
        size: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      }),
    )
    .max(1_000_000),
  /** What stayed on the source, by name, so nothing disappears silently. */
  retained: z.array(z.string().max(1024)).max(4096),
});
export type BodyTransferManifest = z.infer<typeof BodyTransferManifestSchema>;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const Base64Schema = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/u);
export const BodyTransferBundleRequestSchema = z.strictObject({
  transferId: BodyTransferIdSchema,
  offset: z.number().int().nonnegative(),
});
export const BodyTransferBundleChunkSchema = z.strictObject({
  transferId: BodyTransferIdSchema,
  size: z.number().int().nonnegative(),
  sha256: Sha256Schema,
  offset: z.number().int().nonnegative(),
  bytesBase64: Base64Schema.max(Math.ceil((BODY_TRANSFER_DOWNLOAD_CHUNK_BYTES * 4) / 3) + 4),
});
export const BodyTransferStageChunkRequestSchema = z.strictObject({
  transferId: BodyTransferIdSchema,
  offset: z.number().int().nonnegative(),
  bytesBase64: Base64Schema.min(1).max(Math.ceil((BODY_TRANSFER_UPLOAD_CHUNK_BYTES * 4) / 3) + 4),
});
export const BodyTransferStageChunkResultSchema = z.strictObject({
  transferId: BodyTransferIdSchema,
  received: z.number().int().nonnegative(),
});
export const BodyTransferStageRequestSchema = z.strictObject({
  transferId: BodyTransferIdSchema,
  size: z.number().int().nonnegative(),
  sha256: Sha256Schema,
  replace: z.boolean().optional(),
});
export const BodyTransferStageResultSchema = z.strictObject({
  transferId: BodyTransferIdSchema,
  outcome: z.enum(["staged", "applied"]),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
