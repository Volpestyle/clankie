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
    /** Individual operators holding the ambient tier without a mapped role. */
    ambientUserIds: SnowflakeListSchema,
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
    /**
     * Who may summon Clankie into a call inside an allowlisted voice guild.
     * Defaults to the closed policy: voice stays on the ambient binding unless
     * an operator deliberately opens it.
     */
    voiceJoinPolicy: z.enum(["ambient", "guild_members"]).default("ambient"),

    /** Activity plane (ADR 0047): surface → embedded application id. */
    activityApplicationIdGba: SnowflakeSchema.optional(),
  })
  .strict();
export type DiscordSettings = z.infer<typeof DiscordSettingsSchema>;

/**
 * Who Clankie is, as distinct from what he is allowed to do.
 *
 * Identity is layered deliberately. **Character** (this schema) is stable
 * across every surface; the **operating contract** in the captain's authored
 * instructions is also stable; only **register** — how he speaks in the room he
 * is currently in — varies by lane. One person, different rooms.
 *
 * Nothing here grants authority. Register is presentation only: a warmer voice
 * must never widen what the ambient tier may approve, or an agreeable persona
 * becomes a social-engineering surface ([ADR 0051](../../../docs/adr/0051-layered-character-register-and-reply-policy.md)).
 */
export const PersonaSettingsSchema = z
  .object({
    displayName: z.string().min(1).max(64).default("Clankie"),
    /** Extra names he answers to. Humans misspell, shorten, and nickname. */
    aliases: z.array(z.string().min(1).max(64)).max(16).default([]),
    /**
     * Free-text character authored by the owner. This is the taste layer, and
     * it belongs to a human — the code carries it, it does not invent it.
     */
    characterNotes: z.string().max(4_000).default(""),
    /** How readily he speaks, and how much room he takes when he does. */
    chattiness: z.enum(["quiet", "balanced", "chatty"]).default("balanced"),
    /**
     * What earns a reply in an admitted text channel. `addressed` is the
     * default because an open channel allowlist otherwise means replying to
     * every message in the server.
     */
    replyPolicy: z.enum(["addressed", "all"]).default("addressed"),
    /**
     * How many messages may pass in a channel, after he last replied there,
     * before he stops reading it live and lets it pile up until he next checks
     * in. `0` means he only ever answers when named.
     *
     * This decides what he *sees*, never what he must say: he may stay silent
     * on any turn, including one that named him directly.
     */
    liveMessageWindow: z.number().int().min(0).max(100).default(5),
  })
  .strict();
export type PersonaSettings = z.infer<typeof PersonaSettingsSchema>;

export const ClankieSettingsSchema = z
  .object({
    schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION),
    // Defaulted lazily: the parsed output carries every field's own default,
    // which a bare `{}` literal does not satisfy.
    discord: DiscordSettingsSchema.default(() => DiscordSettingsSchema.parse({})),
    persona: PersonaSettingsSchema.default(() => PersonaSettingsSchema.parse({})),
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
