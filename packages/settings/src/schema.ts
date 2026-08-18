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
     * Retain exact consented speech for local development diagnostics. The
     * transcript file is private, separate from the content-free receipt log,
     * and disabled until the owner deliberately enables it.
     */
    voiceTranscriptLoggingEnabled: z.boolean().default(false),
    /**
     * The possessor voice seam (ADR 0064, ADR 0067): whether a process driving
     * his body — asked play, an MCP possessor — may speak and hear through his
     * live voice session. Deny-by-default like every authority binding, and
     * stored here so a bridge restart does not silently mute his playthroughs
     * the way an env-only flag did.
     */
    possessorVoiceEnabled: z.boolean().default(false),

    /**
     * Which Discord body is the mouth. The launcher starts only this process.
     * Both tokens stay stored; only one gateway is live. `user_session` still
     * requires enablement, allowlists, and the durable opt-in.
     */
    activeBody: z.enum(["bot", "user_session"]).default("bot"),

    /**
     * Personal-lab user-session body (ADR 0048). Off by default. Storing a
     * user token is not enough — this flag, the allowlists, the durable
     * opt-in, and `activeBody=user_session` must all be set before the
     * launcher starts that process.
     */
    userSessionEnabled: z.boolean().default(false),
    userSessionGuildIds: SnowflakeListSchema,
    userSessionChannelIds: SnowflakeListSchema,
    /**
     * Whether the lab body may join voice as a participant (talk). Watch
     * joins a channel muted on its own when a share starts and does not
     * require this flag.
     */
    userSessionVoiceEnabled: z.boolean().default(false),
    userSessionVoiceChannelIds: SnowflakeListSchema,
    userSessionDmPolicy: z.enum(["deny", "owner_only", "allowlist"]).default("owner_only"),
    userSessionDmUserIds: SnowflakeListSchema,

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
    /** What he perceives in admitted text channels; silence remains his decision. */
    replyPolicy: z.enum(["addressed", "all"]).default("all"),
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
const ModelIdentifierSchema = z
  .string()
  .regex(/^[\w.-]{1,128}$/u, "must be at most 128 word characters, dots, or hyphens");

/**
 * How Clankie sounds ([ADR 0070](../../../docs/adr/0070-external-voice-via-streaming-tts.md))
 * — a peer of `persona` for the same reason persona is a peer of `discord`:
 * this is who he *is* across surfaces, not a Discord authority knob. Like the
 * rest of settings these are public identifiers; voice-vendor API keys live
 * in the credential broker under their provider ids, never here.
 */
export const VoiceSettingsSchema = z
  .object({
    /** Which vendor owns both the dormant transcriber and engaged voice agent. */
    realtimeProvider: z.enum(["openai", "xai"]).default("openai"),
    /**
     * Who synthesizes his speech. The historical `openai` value means the
     * selected realtime provider's native voice; `elevenlabs` is external TTS.
     */
    ttsProvider: z.enum(["openai", "elevenlabs"]).default("openai"),
    openAiRealtimeModel: ModelIdentifierSchema.optional(),
    openAiTranscribeModel: ModelIdentifierSchema.optional(),
    /** OpenAI realtime voice name (e.g. `marin`); unset defers to the runtime default. */
    openAiVoice: z.string().min(1).max(64).optional(),
    xAiRealtimeModel: ModelIdentifierSchema.optional(),
    /** xAI built-in or custom voice id; unset defers to `eve`. */
    xAiVoice: VendorIdentifierSchema.optional(),
    /** xAI Voice's documented reasoning control. */
    xAiReasoningEffort: z.enum(["high", "none"]).default("high"),
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
    if (value.realtimeProvider === "xai" && value.ttsProvider === "elevenlabs") {
      context.addIssue({
        code: "custom",
        path: ["ttsProvider"],
        message: "elevenlabs text output currently requires realtimeProvider openai",
      });
    }
  });
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;

/** Which PokeAgent bodies the captain may offer. One live session spans both. */
export const GameplaySettingsSchema = z
  .object({
    /** Solo FireRed/Emerald in the local GBA emulator. */
    pokemonEmulatorEnabled: z.boolean().default(true),
    /** FireRed/Emerald in the hosted PokeAgent MMO. */
    pokeagentMmoEnabled: z.boolean().default(true),
  })
  .strict();
export type GameplaySettings = z.infer<typeof GameplaySettingsSchema>;

/** Server ids prefix every tool name they contribute, so keep them identifier-shaped. */
const McpServerIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/u, "must be lowercase letters, digits, and underscores");

/**
 * One MCP server Clankie may call tools on.
 *
 * Owner-authored and non-secret, like everything else here: `credential` names
 * a **broker provider id**, never a token. The host resolves that id at call
 * time and sends it as a Bearer header (http) or injects it into
 * {@link credentialEnv} when spawning the process (stdio).
 *
 * `lane` is the authority gate and defaults closed. A server reached from every
 * room is a capability handed to everyone who can type at him, so widening it
 * is a deliberate edit rather than what happens when the field is omitted.
 */
export const McpServerSchema = z
  .object({
    id: McpServerIdSchema,
    transport: z.enum(["stdio", "http"]).default("stdio"),
    /** stdio: the executable to run. */
    command: z.string().min(1).max(500).optional(),
    args: z.array(z.string().max(1_000)).max(64).default([]),
    /** http: the server endpoint. */
    url: z.string().min(1).max(2_000).optional(),
    lane: z.enum(["operator", "everywhere"]).default("operator"),
    /** Broker provider id holding this server's secret. Never the secret itself. */
    credential: z.string().min(1).max(128).optional(),
    /** stdio only: environment variable that receives the resolved secret. */
    credentialEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/u, "must be an uppercase environment variable name")
      .optional(),
    /**
     * Tools active from the first turn. Empty means all of them — right for a
     * small server, and why a large one should narrow it: everything active is
     * described in the prompt on every turn, and `mcp_tool_search` pulls in the
     * rest on demand.
     */
    initialTools: z.array(z.string().min(1).max(128)).max(64).default([]),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.transport === "stdio" && value.command === undefined) {
      context.addIssue({ code: "custom", path: ["command"], message: "required when transport is stdio" });
    }
    if (value.transport === "http") {
      if (value.url === undefined) {
        context.addIssue({ code: "custom", path: ["url"], message: "required when transport is http" });
        return;
      }
      let parsed: URL;
      try {
        parsed = new URL(value.url);
      } catch {
        context.addIssue({ code: "custom", path: ["url"], message: "must be an absolute URL" });
        return;
      }
      // A bearer token rides every request to this URL. Plaintext is allowed
      // only where it cannot leave the machine.
      const loopback = parsed.hostname === "localhost" || /^127(\.\d{1,3}){3}$/u.test(parsed.hostname);
      if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
        context.addIssue({ code: "custom", path: ["url"], message: "must be https, or http on loopback" });
      }
    }
  });
export type McpServerSettings = z.infer<typeof McpServerSchema>;

/**
 * Owner-authored MCP servers, on top of the connectors Clankie ships knowing
 * about (`/connect linear`). A curated connector needs no entry here; this is
 * the escape hatch for everything else.
 */
export const McpSettingsSchema = z
  .object({
    servers: z.array(McpServerSchema).max(32).default([]),
  })
  .strict();
export type McpSettings = z.infer<typeof McpSettingsSchema>;

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
    gameplay: GameplaySettingsSchema.default(() => GameplaySettingsSchema.parse({})),
    mcp: McpSettingsSchema.default(() => McpSettingsSchema.parse({})),
    email: EmailSettingsSchema.default(() => EmailSettingsSchema.parse({})),
  })
  .strict();
export type ClankieSettings = z.infer<typeof ClankieSettingsSchema>;

export function emptySettings(): ClankieSettings {
  return ClankieSettingsSchema.parse({ schemaVersion: SETTINGS_SCHEMA_VERSION });
}

/**
 * Top-level sections earlier versions wrote that this one no longer has.
 *
 * - `linear`: a default team id, back when a hand-written GraphQL port needed
 *   one. Linear is reached over MCP now and its server resolves the team.
 */
const RETIRED_SETTINGS_KEYS: readonly string[] = ["linear"];

/**
 * Drops sections this version has retired, so an owner whose file predates the
 * change is not met with a parse error on a key that no longer means anything.
 *
 * Deliberately a named list rather than stripping every unknown key: the schema
 * is strict so a typo surfaces loudly instead of silently doing nothing, and
 * that property is worth keeping. A retired section can only ever remove
 * capability, never widen it, which is why it is safe to discard unread.
 */
export function dropRetiredSettings(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const entries = Object.entries(parsed as Record<string, unknown>).filter(
    ([key]) => !RETIRED_SETTINGS_KEYS.includes(key),
  );
  return Object.fromEntries(entries);
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
