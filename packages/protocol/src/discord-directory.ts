import { z } from "zod";

export const DISCORD_DIRECTORY_PATH = "/v1/discord/directory";
export const DISCORD_BODY_DIRECTORY_PATH = "/directory";
const Snowflake = z.string().regex(/^\d{5,32}$/u);
export const DiscordDirectoryRequestSchema = z
  .object({
    kind: z.enum(["servers", "channels", "roles", "people"]).default("servers"),
    guildId: Snowflake.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    after: Snowflake.optional(),
  })
  .strict()
  .refine((input) => input.kind === "servers" || input.guildId !== undefined, {
    message: "Choose a server before listing its channels, roles or people.",
    path: ["guildId"],
  });
export type DiscordDirectoryRequest = z.infer<typeof DiscordDirectoryRequestSchema>;
export const DiscordDirectoryEntrySchema = z
  .object({
    id: Snowflake,
    name: z.string().min(1).max(512),
    kind: z.enum([
      "server",
      "role",
      "person",
      "bot",
      "text",
      "voice",
      "stage",
      "forum",
      "media",
      "announcement",
      "category",
      "thread",
      "other",
    ]),
    guildId: Snowflake.optional(),
  })
  .strict();
export type DiscordDirectoryEntry = z.infer<typeof DiscordDirectoryEntrySchema>;
export const DiscordDirectorySnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    body: z.enum(["bot", "user_session"]),
    kind: z.enum(["servers", "channels", "roles", "people"]),
    state: z.enum(["connected", "disconnected", "partial", "unavailable"]),
    entries: z.array(DiscordDirectoryEntrySchema).max(200),
    hasMore: z.boolean(),
    nextCursor: Snowflake.optional(),
    /** A bounded explanation, not a provider error or credential-bearing exception. */
    reason: z
      .enum([
        "runtime_not_connected",
        "directory_unavailable",
        "server_unavailable",
        "gateway_cache_incomplete",
        "permissions_unknown",
        "people_not_fully_loaded",
      ])
      .optional(),
  })
  .strict();
export type DiscordDirectorySnapshot = z.infer<typeof DiscordDirectorySnapshotSchema>;
