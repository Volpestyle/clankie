import { z } from "zod";

/** Built-in tracker only. Names describe normalized store models, not provider views. */
export const TrackerSyncModelNameSchema = z.enum([
  "issue",
  "comment",
  "project",
  "milestone",
  "document",
  "cycle",
  "release",
  "run",
  "lease",
  "bundle",
  "event",
  "status_update",
  "label",
  "issue_status",
  "project_status",
  "team",
  "user",
]);
const id = z.string().min(1).max(512);
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const projects = z.array(id).min(1).max(100);
export const TrackerSyncCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("bootstrap"),
      type: z.enum(["full", "partial"]),
      projects,
      lazy: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("batch"),
      projects,
      models: z
        .array(z.object({ modelName: TrackerSyncModelNameSchema, modelId: id }).strict())
        .min(1)
        .max(100),
    })
    .strict(),
  z
    .object({
      action: z.literal("subscribe"),
      projects,
      storeId: id,
      lastSyncId: cursor,
      waitMs: z.number().int().min(0).max(20_000).default(20_000),
      limit: z.number().int().min(1).max(250).default(100),
    })
    .strict(),
  z
    .object({
      action: z.literal("transaction"),
      idempotencyKey: z.string().min(1).max(256),
      operations: z
        .array(
          z
            .object({ name: z.string().min(1).max(128), arguments: z.record(z.string(), z.unknown()) })
            .strict(),
        )
        .min(1)
        .max(50),
    })
    .strict(),
]);
export const TrackerSyncModelSchema = z
  .object({
    modelName: TrackerSyncModelNameSchema,
    modelId: id,
    /** Empty means shared metadata. Otherwise these are the current project memberships. */
    projectIds: z.array(id),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();
export const TrackerSyncDeltaSchema = TrackerSyncModelSchema.extend({
  action: z.enum(["insert", "update", "delete"]),
  /** Membership before the change, so leaving a group removes the object there. */
  previousProjectIds: z.array(id),
  /** Update data contains changed fields only; insert data is complete. */
  removedFields: z.array(z.string()),
}).strict();
export const TrackerSyncCommitSchema = z
  .object({
    syncId: cursor,
    at: z.string(),
    actor: z.record(z.string(), z.unknown()),
    tool: z.string(),
    idempotencyKey: z.string().optional(),
    deltas: z.array(TrackerSyncDeltaSchema),
  })
  .strict();
export const TrackerSyncResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("bootstrap"), ndjson: z.string() }).strict(),
  z
    .object({
      outcome: z.literal("batch"),
      storeId: id,
      lastSyncId: cursor,
      models: z.array(TrackerSyncModelSchema),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("deltas"),
      storeId: id,
      lastSyncId: cursor,
      commits: z.array(TrackerSyncCommitSchema),
      hasMore: z.boolean(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("rebootstrap"),
      storeId: id,
      lastSyncId: cursor,
      projects,
      reason: z.enum(["store_changed", "cursor_gap"]),
    })
    .strict(),
  z.object({ outcome: z.literal("applied"), result: z.unknown() }).strict(),
  z.object({ outcome: z.literal("refused"), reason: z.string(), message: z.string() }).strict(),
]);
export type TrackerSyncCommand = z.infer<typeof TrackerSyncCommandSchema>;
export type TrackerSyncModel = z.infer<typeof TrackerSyncModelSchema>;
export type TrackerSyncDelta = z.infer<typeof TrackerSyncDeltaSchema>;
export type TrackerSyncCommit = z.infer<typeof TrackerSyncCommitSchema>;
export type TrackerSyncResult = z.infer<typeof TrackerSyncResultSchema>;
