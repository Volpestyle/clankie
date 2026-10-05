import { z } from "zod";

export const DISCORD_BODY_PERMISSIONS_PATH = "/setup/permissions";
export const DISCORD_BODY_TEST_POST_PATH = "/setup/test-post";
export const DISCORD_SETUP_TEST_POST_PATH = "/v1/discord/setup/test-post";
export const DISCORD_SETUP_TEST_TEXT = "Clankie Discord setup test: messages can reach this room.";
const Id = z.string().regex(/^\d{5,32}$/u);
export const DiscordPermissionStatusSchema = z.enum(["passed", "failed", "not_checked"]);
export const DiscordPermissionsRequestSchema = z
  .object({ guildId: Id.optional(), channelId: Id.optional() })
  .strict()
  .refine((query) => query.guildId !== undefined || query.channelId !== undefined);
export type DiscordPermissionsRequest = z.infer<typeof DiscordPermissionsRequestSchema>;
export const DiscordPermissionsSnapshotSchema = z
  .object({
    body: z.enum(["bot", "user_session"]),
    actorId: Id.optional(),
    guildId: Id.optional(),
    channelId: Id.optional(),
    permissions: z
      .object({
        view_channel: DiscordPermissionStatusSchema,
        send_messages: DiscordPermissionStatusSchema,
        manage_channels: DiscordPermissionStatusSchema,
        manage_webhooks: DiscordPermissionStatusSchema,
      })
      .strict(),
  })
  .strict();
export type DiscordPermissionsSnapshot = z.infer<typeof DiscordPermissionsSnapshotSchema>;
export const DiscordSetupTestPostRequestSchema = z
  .object({
    guildId: Id,
    channelId: Id,
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export const DiscordBodyTestPostRequestSchema = DiscordSetupTestPostRequestSchema.omit({
  expectedRevision: true,
})
  .extend({ actorId: Id })
  .strict();
export type DiscordBodyTestPostRequest = z.infer<typeof DiscordBodyTestPostRequestSchema>;
export const DiscordSetupTestPostResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("posted"),
      body: z.enum(["bot", "user_session"]),
      guildId: Id,
      channelId: Id,
      messageId: Id,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("unavailable"),
      reason: z.enum(["permissions_not_verified", "account_changed", "runtime_unavailable"]),
    })
    .strict(),
  z.object({ outcome: z.literal("unconfirmed"), reason: z.literal("post_receipt_unavailable") }).strict(),
]);
export type DiscordSetupTestPostResult = z.infer<typeof DiscordSetupTestPostResultSchema>;
