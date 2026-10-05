import { z } from "zod";

/** Read-only Activity transport; no machine, account or capture authority. */
export const ACTIVITY_SHARES_PATH = "/v1/activity/shares";
export const ACTIVITY_VIEWER_PATH = "/v1/activity/viewer";
const identity = z.string().min(1).max(128);
export const ActivityScopeSchema = z
  .object({
    tenantId: identity,
    installationId: identity,
    guildId: identity,
    channelId: identity,
  })
  .strict();
export const ActivitySessionSchema = z
  .object({
    shareId: z.string().uuid(),
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    scope: ActivityScopeSchema,
    source: z
      .object({
        kind: z.enum(["game", "image", "animation", "demo"]),
        id: identity,
        title: z.string().min(1).max(256),
      })
      .strict(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type ActivitySession = z.infer<typeof ActivitySessionSchema>;
export const ActivityLaunchReceiptSchema = z
  .object({
    outcome: z.enum(["confirmed", "refused", "uncertain"]),
    receiptId: z.string().uuid(),
    session: ActivitySessionSchema,
    inviteUrl: z.string().url().optional(),
  })
  .strict();
export const ActivityAuthorizationSchema = z
  .object({
    session: ActivitySessionSchema,
    authorization: z.string().min(32).max(128),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type ActivityAuthorization = z.infer<typeof ActivityAuthorizationSchema>;
export const ActivityAdmitRequestSchema = z
  .object({ code: z.string().min(1).max(2048), instanceId: z.string().min(1).max(128) })
  .strict();
export const ActivityAdmissionSchema = ActivityAuthorizationSchema.extend({
  accessToken: z.string().min(1).max(4096),
}).strict();
export const ActivityBodyRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("authorize"), installationId: identity, scope: ActivityScopeSchema }).strict(),
  z
    .object({
      action: z.literal("launch"),
      installationId: identity,
      requestId: z.string().uuid(),
      session: ActivitySessionSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("stop"),
      installationId: identity,
      requestId: z.string().uuid(),
      session: ActivitySessionSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("revalidate"),
      installationId: identity,
      authorization: z.string().min(32).max(128),
    })
    .strict(),
]);
export const ActivityViewerRequestSchema = z
  .object({
    session: ActivitySessionSchema,
    authorization: z.string().min(32).max(128),
    permit: z.string().min(1).max(8192),
  })
  .strict();

const artifact = {
  conversationId: z.string().min(1).max(256),
  artifactId: z.string().regex(/^[a-f0-9]{48}$/u),
};
const sourceId = z.string().min(1).max(128);
const reference = { shareId: z.string().uuid(), generation: z.number().int().positive() };
const destination = {
  guildId: z.string().regex(/^[0-9]{1,32}$/u),
  channelId: z.string().regex(/^[0-9]{1,32}$/u),
  ttlMs: z.number().int().positive().max(7_200_000).optional(),
};
export const ActivitySharingRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("image"), ...artifact, ...destination }).strict(),
  z.object({ action: z.literal("start"), sourceId, ...destination }).strict(),
  z
    .object({
      action: z.literal("switch"),
      ...reference,
      sourceId: sourceId.optional(),
      conversationId: artifact.conversationId.optional(),
      artifactId: artifact.artifactId.optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.sourceId !== undefined
          ? value.conversationId === undefined && value.artifactId === undefined
          : value.conversationId !== undefined && value.artifactId !== undefined,
      "Choose exactly one registered source or delivered artifact",
    ),
  z.object({ action: z.literal("stop"), ...reference }).strict(),
  z.object({ action: z.literal("grant"), ...reference }).strict(),
]);

export type ActivitySharingRequest = z.infer<typeof ActivitySharingRequestSchema>;
export const ActivitySharingResponseSchema = z.union([
  z.object({ sessions: z.array(ActivitySessionSchema) }).strict(),
  z.object({ session: ActivitySessionSchema, receipt: ActivityLaunchReceiptSchema.optional() }).strict(),
  z.object({ stopped: z.literal(true), receipt: ActivityLaunchReceiptSchema.optional() }).strict(),
  z.object({ grant: z.string().min(1).max(512), expiresAt: z.string().datetime() }).strict(),
]);
export type ActivitySharingResponse = z.infer<typeof ActivitySharingResponseSchema>;
