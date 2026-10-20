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
const savedViewScope = {
  project: z.uuid(),
  storeId: z.string().min(1).max(128),
};
const savedViewPagination = {
  limit: z.number().int().min(1).max(250).optional(),
  cursor: z.string().optional(),
  orderBy: z.enum(["createdAt", "updatedAt"]).optional(),
};
/** Canonical persisted definition. Applying it always reads the current tracker. */
export const TrackerSavedIssueViewSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    storeId: z.string().min(1).max(128),
    projectId: z.uuid(),
    name: z.string().min(1).max(120),
    filter: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();
export const TrackerSyncCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("list_issue_views"),
      ...savedViewScope,
      ...savedViewPagination,
    })
    .strict(),
  z
    .object({
      action: z.literal("list_issue_view_issues"),
      ...savedViewScope,
      id: z.uuid(),
      ...savedViewPagination,
    })
    .strict(),
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
      /** The store the client bootstrapped; a replaced store refuses (`store_replaced`) in the same atomic write. */
      expectedStoreId: id.optional(),
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
  z
    .object({
      outcome: z.literal("issue_views"),
      storeId: z.string().min(1).max(128),
      projectId: z.uuid(),
      views: z.array(TrackerSavedIssueViewSchema),
      hasNextPage: z.boolean(),
      cursor: z.string().optional(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("issue_view_issues"),
      storeId: z.string().min(1).max(128),
      projectId: z.uuid(),
      viewId: z.uuid(),
      /** Normal list_issues records, with the canonical mapper's fields unchanged. */
      issues: z.array(z.record(z.string(), z.unknown())),
      hasNextPage: z.boolean(),
      cursor: z.string().optional(),
    })
    .strict(),
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
export type TrackerSavedIssueView = z.infer<typeof TrackerSavedIssueViewSchema>;
export type TrackerSyncModel = z.infer<typeof TrackerSyncModelSchema>;
export type TrackerSyncDelta = z.infer<typeof TrackerSyncDeltaSchema>;
export type TrackerSyncCommit = z.infer<typeof TrackerSyncCommitSchema>;
export type TrackerSyncResult = z.infer<typeof TrackerSyncResultSchema>;
