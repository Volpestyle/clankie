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

export const DiscordSettingsSchema = z
  .object({
    /** One connected server. Discord permissions decide the rooms Clankie can inhabit. */
    serverId: SnowflakeSchema.optional(),
    role: DiscordRoleSchema.default("participant"),
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
    /**
     * Discord users whose text turns get the operator's machine tools
     * (bash, read, write, edit — and therefore herdr). Empty means nobody:
     * Discord stays social. The operator console is always privileged and
     * does not consult this list. Distinct from `ownerUserId` (DM policy)
     * and `ambientUserIds` (slash-command tier) so those policies can move
     * without handing out a shell. An official-bot DM with one of these users
     * is a private durable operator lane; their turns in an ordinary shared
     * room remain one-shot.
     */
    systemActorUserIds: SnowflakeListSchema,
    /**
     * Guilds whose admitted members share durable machine access. This is an
     * explicit remote-shell grant to every human the Discord gateway admits in
     * the selected rooms; it never inherits from the text/voice ingress lists.
     */
    systemActorGuildIds: SnowflakeListSchema,
    /** Optional room refinement below `systemActorGuildIds`; empty means every admitted room in those guilds. */
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
  return {
    ...settings,
    guildId: settings.serverId,
    swarmGuildId: settings.role === "admin" ? settings.serverId : undefined,
    teamVisible: settings.fleetEnabled,
    textIngressEnabled: true,
    ingressGuildIds: [settings.serverId],
    ingressChannelIds: [],
    presenceGuildIds: [settings.serverId],
    presenceChannelIds: [],
    voiceEnabled: true,
    voiceGuildIds: [settings.serverId],
    voiceChannelIds: [],
    voiceChannelId: undefined,
    voiceJoinPolicy: "guild_members",
    userSessionGuildIds: [settings.serverId],
    // The lab body’s recorded opt-in is a separate trust ceiling, retained in Advanced.
  };
}
