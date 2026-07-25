import { z } from "zod";

/**
 * Operator settings: **non-secret** configuration only.
 *
 * The split from `@clankie/credential-broker` is deliberate. The broker stores
 * values that grant access — it writes to the macOS Keychain, redacts on
 * display, and validates typed token patterns. Everything here is a public
 * identifier an operator reads off a Discord UI and legitimately wants to *see*
 * when checking their configuration, so redaction would be actively unhelpful.
 *
 * Nothing in this schema may hold a token. {@link assertNoSecretShapedValue}
 * enforces that at the write boundary rather than trusting convention.
 */
export const SETTINGS_SCHEMA_VERSION = 1 as const;

/** Discord snowflakes are numeric strings; reject anything else early. */
const SnowflakeSchema = z.string().regex(/^\d{5,32}$/u, "must be a numeric Discord id");
const SnowflakeListSchema = z.array(SnowflakeSchema).max(64).default([]);

export const DiscordSettingsSchema = z
  .object({
    applicationId: SnowflakeSchema.optional(),
    guildId: SnowflakeSchema.optional(),
    ambientRoleIds: SnowflakeListSchema,
    approvalRoleIds: SnowflakeListSchema,
    ownerUserId: SnowflakeSchema.optional(),

    textIngressEnabled: z.boolean().default(false),
    ingressGuildIds: SnowflakeListSchema,
    ingressChannelIds: SnowflakeListSchema,
    ingressDmPolicy: z.enum(["deny", "owner_only", "allowlist"]).default("deny"),
    ingressDmUserIds: SnowflakeListSchema,
    ingressContextMessages: z.number().int().min(0).max(50).default(10),

    presenceGuildIds: SnowflakeListSchema,
    presenceChannelIds: SnowflakeListSchema,

    voiceEnabled: z.boolean().default(false),
    voiceGuildIds: SnowflakeListSchema,
    voiceChannelIds: SnowflakeListSchema,
    voiceChannelId: SnowflakeSchema.optional(),

    /** Activity plane (ADR 0047): surface → embedded application id. */
    activityApplicationIdGba: SnowflakeSchema.optional(),
  })
  .strict();
export type DiscordSettings = z.infer<typeof DiscordSettingsSchema>;

export const ClankieSettingsSchema = z
  .object({
    schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION),
    // Defaulted lazily: the parsed output carries every field's own default,
    // which a bare `{}` literal does not satisfy.
    discord: DiscordSettingsSchema.default(() => DiscordSettingsSchema.parse({})),
  })
  .strict();
export type ClankieSettings = z.infer<typeof ClankieSettingsSchema>;

export function emptySettings(): ClankieSettings {
  return ClankieSettingsSchema.parse({ schemaVersion: SETTINGS_SCHEMA_VERSION });
}

/** Token prefixes that must never reach the settings file. */
const SECRET_PREFIXES = [
  "clankie_",
  "sk-",
  "xoxb-",
  "ghp_",
  "github_pat_",
  "figd_",
  "lin_api_",
  "Bot ",
  "Bearer ",
];

/**
 * Refuse to persist anything token-shaped.
 *
 * A settings file is world-readable-ish by intent (mode 0600, but shown in the
 * TUI unredacted and safe to paste into an issue). A secret landing here would
 * be disclosed by the very affordances that make settings useful, so the write
 * path fails closed instead of relying on the operator to notice.
 */
export function assertNoSecretShapedValue(settings: unknown): void {
  for (const value of walkStrings(settings)) {
    const trimmed = value.trim();
    if (SECRET_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
      throw new Error(
        "settings_secret_shaped_value: a token-shaped value cannot be stored in settings; use the credential broker",
      );
    }
    // Discord bot tokens are dot-separated base64 segments of substantial length.
    if (/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}$/u.test(trimmed)) {
      throw new Error(
        "settings_secret_shaped_value: a token-shaped value cannot be stored in settings; use the credential broker",
      );
    }
  }
}

function* walkStrings(value: unknown): Generator<string> {
  if (typeof value === "string") {
    yield value;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* walkStrings(item);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) yield* walkStrings(item);
  }
}
