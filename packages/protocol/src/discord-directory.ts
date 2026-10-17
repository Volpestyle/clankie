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
/** Only bounded directory queries may cross the encrypted gateway. Unknown,
 * duplicate or encoded parameters are refused before route normalization. */
export function isDiscordDirectoryRoute(route: string): boolean {
  if (route === DISCORD_DIRECTORY_PATH) return true;
  if (!route.startsWith(`${DISCORD_DIRECTORY_PATH}?`) || route.length > 2048) return false;
  const query = route.slice(DISCORD_DIRECTORY_PATH.length + 1);
  const values: Record<string, string> = {};
  for (const parameter of query.split("&")) {
    if (
      !/^(?:kind=(?:servers|channels|roles|people)|guildId=\d{5,32}|limit=[1-9]\d{0,2}|after=\d{5,32})$/u.test(
        parameter,
      )
    )
      return false;
    const [name, value] = parameter.split("=") as [string, string];
    if (Object.hasOwn(values, name)) return false;
    values[name] = value;
  }
  return DiscordDirectoryRequestSchema.safeParse(values).success;
}

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
