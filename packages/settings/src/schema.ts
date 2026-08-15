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
    /**
     * Discord users whose text turns get the operator's machine tools
     * (bash, read, write, edit — and therefore herdr). Empty means nobody:
     * Discord stays social. The operator console is always privileged and
     * does not consult this list. Distinct from `ownerUserId` (DM policy)
     * and `ambientUserIds` (slash-command tier) so those policies can move
     * without handing out a shell.
     */
    systemActorUserIds: SnowflakeListSchema,

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
    /**
     * Who counts as consented to being heard (ADR 0045). `explicit` requires
     * `/clankie voice-consent opt-in` per participant per session; `presence`
     * treats being in his active channel as consent — the owner's call for a
     * private room whose participants know he transcribes when he is in it.
     * An explicit opt-out binds under either policy.
     */
    voiceConsentPolicy: z.enum(["explicit", "presence"]).default("explicit"),
    /**
     * The possessor voice seam (ADR 0064, ADR 0067): whether a process driving
     * his body — asked play, an MCP possessor — may speak and hear through his
     * live voice session. Deny-by-default like every authority binding, and
     * stored here so a bridge restart does not silently mute his playthroughs
     * the way an env-only flag did.
     */
    possessorVoiceEnabled: z.boolean().default(false),

    /** Activity plane (ADR 0047): surface → embedded application id. */
    activityApplicationIdGba: SnowflakeSchema.optional(),
    /**
     * The named Cloudflare tunnel that publishes the activity surface, as
     * created by `cloudflared tunnel create <name>`.
     *
     * Named rather than quick on purpose. A quick tunnel mints a fresh
     * `*.trycloudflare.com` hostname on every start, and Discord's activity URL
     * mapping is configured once in the developer portal — so a quick tunnel
     * makes restarting the thing that publishes him a breaking change, which is
     * how one came to be left running for six days until its edge died and the
     * activity went blank with nothing reporting it. A named tunnel keeps its
     * hostname across restarts, which is what lets the launcher own it at all.
     *
     * Absent means the launcher runs no tunnel and the activity stays local.
     */
    activityTunnelName: z.string().min(1).optional(),
    /**
     * The public hostname routed to that tunnel, used to probe the whole path
     * end to end rather than only asking whether a process is alive. The
     * 2026-08-01 failure had a healthy local server, a live `cloudflared`
     * process, and a dead edge — process liveness would have called that fine.
     */
    activityTunnelHostname: z.string().min(1).optional(),
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

/** Vendor identifiers travel in URLs and protocol frames; constrain them early. */
const VendorIdentifierSchema = z
  .string()
  .regex(/^[\w-]{1,128}$/u, "must be at most 128 word characters or hyphens");

/**
 * How Clankie sounds ([ADR 0070](../../../docs/adr/0070-external-voice-via-streaming-tts.md))
 * — a peer of `persona` for the same reason persona is a peer of `discord`:
 * this is who he *is* across surfaces, not a Discord authority knob. Like the
 * rest of settings these are public identifiers; the ElevenLabs API key lives
 * in the credential broker under provider id `elevenlabs`, never here.
 */
export const VoiceSettingsSchema = z
  .object({
    /**
     * Who synthesizes his speech: `openai` is the realtime model's own voice,
     * `elevenlabs` streams the model's words through ElevenLabs TTS.
     */
    ttsProvider: z.enum(["openai", "elevenlabs"]).default("openai"),
    /** OpenAI realtime voice name (e.g. `marin`); unset defers to the runtime default. */
    openAiVoice: z.string().min(1).max(64).optional(),
    /** Public ElevenLabs voice identifier, required when {@link ttsProvider} is `elevenlabs`. */
    elevenLabsVoiceId: VendorIdentifierSchema.optional(),
    /** ElevenLabs model (e.g. `eleven_flash_v2_5`); unset defers to the runtime default. */
    elevenLabsModelId: VendorIdentifierSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ttsProvider === "elevenlabs" && value.elevenLabsVoiceId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["elevenLabsVoiceId"],
        message: "required when ttsProvider is elevenlabs",
      });
    }
  });
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;

/**
 * Linear is a tool connector, not a body: the API key lives in the credential
 * broker under provider id `linear`. This file only holds the public default
 * team so creating an issue does not ask every time.
 */
export const LinearSettingsSchema = z
  .object({
    /** Linear team UUID (not the ENG-style key). */
    defaultTeamId: z.string().min(1).max(64).optional(),
  })
  .strict();
export type LinearSettings = z.infer<typeof LinearSettingsSchema>;

const HostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/u,
    {
      message: "must be a hostname",
    },
  );

/**
 * Mailbox coordinates. The password is broker-owned under provider id `email`.
 * Hosts and the username are public identifiers an operator wants to read back.
 */
export const EmailSettingsSchema = z
  .object({
    imapHost: HostnameSchema.optional(),
    imapPort: z.number().int().min(1).max(65535).default(993),
    smtpHost: HostnameSchema.optional(),
    smtpPort: z.number().int().min(1).max(65535).default(587),
    username: z.string().min(1).max(320).optional(),
    /** IMAP implicit TLS (usually port 993). SMTP uses its own port to pick STARTTLS vs implicit. */
    secure: z.boolean().default(true),
  })
  .strict();
export type EmailSettings = z.infer<typeof EmailSettingsSchema>;

export const ClankieSettingsSchema = z
  .object({
    schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION),
    // Defaulted lazily: the parsed output carries every field's own default,
    // which a bare `{}` literal does not satisfy.
    discord: DiscordSettingsSchema.default(() => DiscordSettingsSchema.parse({})),
    persona: PersonaSettingsSchema.default(() => PersonaSettingsSchema.parse({})),
    voice: VoiceSettingsSchema.default(() => VoiceSettingsSchema.parse({})),
    linear: LinearSettingsSchema.default(() => LinearSettingsSchema.parse({})),
    email: EmailSettingsSchema.default(() => EmailSettingsSchema.parse({})),
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
