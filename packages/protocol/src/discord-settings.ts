import { z } from "zod";
import { DiscordWakeTriggerSchema } from "./discord-ids.ts";

export { discordWakeTrigger, type DiscordWakeTrigger } from "./discord-ids.ts";

/** Discord snowflakes are numeric strings; reject anything else early. */
const SnowflakeSchema = z.string().regex(/^\d{5,32}$/u, "must be a numeric Discord id");
const SnowflakeListSchema = z.array(SnowflakeSchema).max(64).default([]);

export const DiscordRoleSchema = z.enum(["participant", "admin"]);
export const DiscordTrackingLevelSchema = z.enum([
  "off",
  "project_updates",
  "project_activity",
  "all_issues",
]);

export const DiscordServerPolicySchema = z
  .object({
    serverId: SnowflakeSchema,
    role: DiscordRoleSchema.default("participant"),
    owners: z.enum(["me", "everyone", "role"]).default("me"),
    ownerRoleId: SnowflakeSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.owners !== "role" || value.ownerRoleId !== undefined,
    "Choose the Discord role that owns Clankie.",
  );
export const DiscordRoomSkillGrantSchema = z
  .object({
    serverId: SnowflakeSchema,
    channelId: SnowflakeSchema,
    skill: z.enum(["house-hunting"]),
    /** Migration-only binding to the existing household; otherwise isolated per room. */
    household: z.enum(["existing"]).optional(),
  })
  .strict();

export const HouseHuntingAuthorBindingSchema = z
  .object({
    household: z.union([z.literal("existing"), z.string().regex(/^\d{5,32}-\d{5,32}$/u)]),
    userId: SnowflakeSchema,
    legacyAuthor: z
      .string()
      .min(1)
      .max(256)
      .refine(
        (label) =>
          label.trim() === label &&
          !/^\p{Decimal_Number}+$/u.test(label) &&
          Array.from(label).every((char) => {
            const code = char.charCodeAt(0);
            return code >= 32 && (code < 127 || code > 159);
          }),
        "Use an exact legacy author label, not a Discord ID or display-name claim",
      ),
    ownerConfirmed: z.literal(true),
  })
  .strict();

export const DiscordSettingsSchema = z
  .object({
    /** One connected server. Discord permissions decide the rooms Clankie can inhabit. */
    serverId: SnowflakeSchema.optional(),
    role: DiscordRoleSchema.default("participant"),
    servers: z
      .array(DiscordServerPolicySchema)
      .max(64)
      .default([])
      .refine(
        (values) => new Set(values.map((v) => v.serverId)).size === values.length,
        "Duplicate server policy",
      ),
    roomSkills: z
      .array(DiscordRoomSkillGrantSchema)
      .max(64)
      .default([])
      .refine(
        (values) => new Set(values.map((v) => `${v.serverId}:${v.channelId}`)).size === values.length,
        "Duplicate room grant",
      ),
    houseHuntingAuthorBindings: z
      .array(HouseHuntingAuthorBindingSchema)
      .max(64)
      .default([])
      .refine(
        (bindings) =>
          new Set(bindings.map((b) => JSON.stringify([b.household, b.legacyAuthor]))).size ===
          bindings.length,
        "Each legacy author can be bound to only one Discord ID per household",
      ),
    fleetEnabled: z.boolean().default(false),
    /** Participant fleet messages use this existing room; raw IDs stay in Advanced. */
    fleetChannelId: SnowflakeSchema.optional(),
    trackingLevel: DiscordTrackingLevelSchema.default("off"),
    applicationId: SnowflakeSchema.optional(),
    /** The command and live-proof server. Not where the fleet gets rooms. */
    guildId: SnowflakeSchema.optional(),
    /**
     * The one server Clankie controls and may make rooms in (ADR 0146): the
     * managed server. Deliberately not `guildId` — a server he merely inhabits can
     * be on every ingress, presence, and voice allowlist without ever becoming
     * a place his agents can be given a channel in. Unset means no Discord
     * projection at all — not even a pasted webhook, which would otherwise be
     * the way into a server nobody named.
     */
    swarmGuildId: SnowflakeSchema.optional(),
    /** Reversible team display gate. Omitted means visible; hiding retains the selected server. */
    teamVisible: z.boolean().optional(),
    ambientRoleIds: SnowflakeListSchema,
    /** Individual operators holding the ambient tier without a mapped role. */
    ambientUserIds: SnowflakeListSchema,
    approvalRoleIds: SnowflakeListSchema,
    ownerUserId: SnowflakeSchema.optional(),
    /** Explicit individual compatibility grants; owners come from per-server policies.
     * Private official-bot DMs may be durable; mixed rooms stay one-shot. */
    systemActorUserIds: SnowflakeListSchema,
    /**
     * Retired compatibility input. Never grants machine authority (ADR 0251).
     */
    systemActorGuildIds: SnowflakeListSchema,
    /** Retired compatibility input; migrated skill rooms use roomSkills. */
    systemActorChannelIds: SnowflakeListSchema,

    textIngressEnabled: z.boolean().default(false),
    ingressGuildIds: SnowflakeListSchema,
    ingressChannelIds: SnowflakeListSchema,
    ingressDmPolicy: z.enum(["deny", "owner_only", "allowlist"]).default("deny"),
    ingressDmUserIds: SnowflakeListSchema,
    ingressContextMessages: z.number().int().min(0).max(50).default(10),
    /**
     * What wakes Clankie for ordinary channel chat (VUH-1765): `mention` (an
     * @mention, DM, reply or slash command; his name alone does not count),
     * `name` (also his name in a message), or `any` (every admitted message; he
     * decides whether to answer). Unset keeps each body's default: self-hosted
     * follows `persona.replyPolicy` (`all` → `any`, `addressed` → `name`), and
     * the hosted edge uses `mention`. A stored `addressed` is the earlier
     * spelling of `mention`.
     */
    wakeTrigger: DiscordWakeTriggerSchema.optional(),
    /**
     * Hosted and official-bot channels whose ordinary chat the edge may keep in a
     * short encrypted buffer for context (VUH-1765). Opt-in per channel by a
     * server admin; empty means no ambient ingestion anywhere.
     */
    ambientChannelIds: SnowflakeListSchema,
    /** Guild text channels where the body shows deterministic, content-free tool activity cards. */
    toolProgressChannelIds: SnowflakeListSchema,

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
     * Retain consented speech and generated reply text for local development diagnostics. The
     * transcript file is private, separate from the content-free receipt log,
     * and disabled until the owner deliberately enables it.
     */
    voiceTranscriptLoggingEnabled: z.boolean().default(false),
    /**
     * Which Discord body is the mouth. The launcher starts only this process.
     * Both tokens stay stored; only one gateway is live. `user_session` still
     * requires enablement, allowlists, and the durable opt-in.
     */
    activeBody: z.enum(["bot", "user_session"]).default("bot"),
    /**
     * Free official Clankie bot through the signed-in Clankie account (VUH-1766).
     * The hosted edge holds the official token and delivers sealed messages to
     * this machine; no developer portal, bot token or intents setup. Independent
     * of `activeBody`: a bring-your-own bot can still run beside it.
     */
    officialBotEnabled: z.boolean().default(false),

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

/** Project the server role model into the existing body configuration without granting machine access. */
export function discordServerSettings(
  settings: DiscordSettings,
  previous?: DiscordSettings,
): DiscordSettings {
  if (!settings.serverId)
    return previous?.serverId
      ? {
          ...settings,
          guildId: undefined,
          swarmGuildId: undefined,
          teamVisible: false,
          textIngressEnabled: false,
          ingressGuildIds: [],
          ingressChannelIds: [],
          presenceGuildIds: [],
          presenceChannelIds: [],
          voiceEnabled: false,
          voiceGuildIds: [],
          voiceChannelIds: [],
          voiceChannelId: undefined,
          userSessionGuildIds: [],
        }
      : settings;
  const policy = settings.servers.find((entry) => entry.serverId === settings.serverId);
  const role = previous && previous.role !== settings.role ? settings.role : (policy?.role ?? settings.role);
  const servers = policy
    ? settings.servers.map((entry) => (entry.serverId === settings.serverId ? { ...entry, role } : entry))
    : [...settings.servers, { serverId: settings.serverId, role, owners: "me" as const }];
  const guilds = [...new Set([settings.serverId, ...servers.map((entry) => entry.serverId)])];
  return {
    ...settings,
    role,
    servers,
    guildId: settings.serverId,
    swarmGuildId: role === "admin" ? settings.serverId : undefined,
    teamVisible: settings.fleetEnabled,
    textIngressEnabled: true,
    ingressGuildIds: guilds,
    ingressChannelIds: [],
    presenceGuildIds: guilds,
    presenceChannelIds: [],
    voiceEnabled: true,
    voiceGuildIds: guilds,
    voiceChannelIds: [],
    voiceChannelId: undefined,
    voiceJoinPolicy: "guild_members",
    userSessionGuildIds: guilds,
    // The lab body’s recorded opt-in is a separate trust ceiling, retained in Advanced.
  };
}

/** Read-time upgrade; only recorded legacy configurations receive personal migration bindings. */
export function migrateDiscordOwnership(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const value = raw as Record<string, unknown>;
  if (!value.discord || typeof value.discord !== "object" || Array.isArray(value.discord)) return raw;
  const discord = value.discord as Record<string, unknown>;
  if (Object.hasOwn(discord, "servers")) return raw;
  const list = (key: string): string[] => (Array.isArray(discord[key]) ? (discord[key] as string[]) : []);
  const ids = new Set([
    ...list("ingressGuildIds"),
    ...list("systemActorGuildIds"),
    ...[discord.serverId, discord.swarmGuildId, discord.guildId].filter(
      (id): id is string => typeof id === "string",
    ),
  ]);
  const household =
    list("systemActorGuildIds").includes("1052402897645752351") ||
    list("systemActorChannelIds").includes("1551975693582336060");
  if (household) ids.add("1052402897645752351");
  return {
    ...value,
    discord: {
      ...discord,
      servers: [...ids].map((serverId) => ({
        serverId,
        role:
          serverId === "866430493889134672"
            ? "admin"
            : serverId === "1052402897645752351"
              ? "participant"
              : serverId === discord.swarmGuildId
                ? "admin"
                : serverId === discord.serverId
                  ? (discord.role ?? "participant")
                  : "participant",
        owners: "me",
      })),
      roomSkills: household
        ? [
            {
              serverId: "1052402897645752351",
              channelId: "1551975693582336060",
              skill: "house-hunting",
              household: "existing",
            },
          ]
        : [],
      systemActorGuildIds: [],
      systemActorChannelIds: [],
    },
  };
}
