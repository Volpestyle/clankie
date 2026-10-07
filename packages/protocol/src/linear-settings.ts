import { z } from "zod";

export const LinearWakeSettingsSchema = z
  .object({
    ownerUserIds: z.array(z.string().min(1).max(256)).max(100).default([]),
    /** Matched only against verified webhook actor email, never display names. */
    ownerUserEmails: z.array(z.email().max(320)).max(100).default([]),
    actors: z
      .array(z.enum(["owner", "human", "self", "users"]))
      .max(4)
      .default(["owner"]),
    userIds: z.array(z.string().min(1).max(256)).max(100).default([]),
    notificationTypes: z
      .array(z.string().min(1).max(128))
      .max(100)
      .default([
        "issueNewComment",
        "issueCommentMention",
        "issueMention",
        "issueAssignedToYou",
        "issueCommentReaction",
        "projectUpdateNewComment",
        "projectUpdateMention",
        "initiativeUpdateNewComment",
        "initiativeUpdateMention",
        "documentNewComment",
        "documentMention",
      ]),
    excludedNotificationTypes: z.array(z.string().min(1).max(128)).max(100).default(["issueSubscribed"]),
  })
  .strict();
export type LinearWakeSettings = z.infer<typeof LinearWakeSettingsSchema>;
export const LINEAR_FOLLOW_PATH = "/v1/linear/follow";
export const LINEAR_WAKE_PATH = "/v1/linear/wake";
const Revision = z.string().regex(/^[a-f0-9]{64}$/u);
export const LinearWakeSnapshotSchema = z
  .object({ schemaVersion: z.literal(1), revision: Revision, wake: LinearWakeSettingsSchema })
  .strict();
export const LinearWakeUpdateSchema = z
  .object({ expectedRevision: Revision, wake: LinearWakeSettingsSchema })
  .strict();
export const LinearFollowSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: Revision,
    following: z.boolean(),
    active: z.boolean(),
    webhookConfigured: z.boolean(),
    reason: z.literal("linear_webhook_required").nullable(),
    missingWebhook: z.array(z.enum(["url", "secret"])),
    wakeWarning: z.string().nullable(),
    detail: z.string().nullable(),
    wakeConversationId: z.string(),
  })
  .strict();
export const LinearFollowUpdateSchema = z
  .object({ expectedRevision: Revision, following: z.boolean() })
  .strict();
