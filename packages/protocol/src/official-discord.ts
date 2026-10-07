import { z } from "zod";
import { DiscordIdSchema, DiscordWakeTriggerSchema } from "./discord-ids.ts";

/**
 * The free official-bot route for a self-hosted install (VUH-1766). A machine
 * signed in with `clankie login` registers its Discord ingress key with the
 * hosted fleet; the hosted Discord edge then delivers sealed, permit-bound
 * events to it through the public gateway. The official bot token never leaves
 * the edge. The route carries Discord delivery only: no hosted body, no
 * included model usage and no paid-plan features.
 */
export const OFFICIAL_DISCORD_PATHS = {
  register: "/fleet/v1/self-hosted/discord/register",
  status: "/fleet/v1/self-hosted/discord/status",
  unregister: "/fleet/v1/self-hosted/discord/unregister",
} as const;

/** The account page where the owner finishes "Add to Discord" in a browser. */
export const OFFICIAL_DISCORD_ACCOUNT_PAGE = "/fleet/account/?discord=self-hosted";

const InstallationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/u);
export const OfficialDiscordRouteIdSchema = z.string().regex(/^tn_[a-z2-7]{20}$/u);

export const OfficialDiscordRegisterRequestSchema = z
  .object({
    installationId: InstallationIdSchema,
    /** Uncompressed P-256 point, base64url: the machine's ingress sealing key. */
    publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/u),
  })
  .strict();
export type OfficialDiscordRegisterRequest = z.infer<typeof OfficialDiscordRegisterRequestSchema>;

export const OfficialDiscordRegistrationSchema = z
  .object({
    routeId: OfficialDiscordRouteIdSchema,
    installationId: InstallationIdSchema,
    /** Public Ed25519 keys the machine checks fleet permits with. Never a secret. */
    verifyKeys: z
      .object({
        keys: z
          .array(z.object({ publicKeyPem: z.string().min(1).max(1_000) }).strict())
          .min(1)
          .max(2),
      })
      .strict(),
  })
  .strict();
export type OfficialDiscordRegistration = z.infer<typeof OfficialDiscordRegistrationSchema>;

/** Every free-route limit has a stable name, so a refusal can say which one was hit. */
export const OfficialDiscordLimitNameSchema = z.enum([
  "account_messages_per_minute",
  "account_messages_per_day",
  "server_messages_per_minute",
  "server_messages_per_day",
  "account_wakes_per_day",
  "server_wakes_per_day",
  "account_sends_per_day",
  "server_sends_per_day",
]);
export type OfficialDiscordLimitName = z.infer<typeof OfficialDiscordLimitNameSchema>;

export const OfficialDiscordLimitUsageSchema = z
  .object({
    limit: OfficialDiscordLimitNameSchema,
    used: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
    resetsAtMs: z.number().int().nonnegative(),
  })
  .strict();

export const OfficialDiscordBlockSchema = z
  .object({
    scope: z.enum(["account", "server"]),
    reason: z.string().min(1).max(200),
    atMs: z.number().int().nonnegative(),
  })
  .strict();
export type OfficialDiscordBlock = z.infer<typeof OfficialDiscordBlockSchema>;

export const OfficialDiscordStatusSchema = z
  .object({
    registered: z.boolean(),
    routeId: OfficialDiscordRouteIdSchema.optional(),
    installationId: InstallationIdSchema.optional(),
    /** The official application, so an owner can tell it apart from a bring-your-own bot. */
    applicationId: z
      .string()
      .regex(/^\d{5,32}$/u)
      .optional(),
    /** Where to finish Add to Discord in a browser signed in to the same account. */
    installUrl: z.string().url(),
    blocked: OfficialDiscordBlockSchema.optional(),
    discord: z
      .object({
        connected: z.boolean(),
        guildId: DiscordIdSchema.optional(),
        guildName: z.string().max(100).optional(),
        channelIds: z.array(DiscordIdSchema).max(25).optional(),
        ambientChannelIds: z.array(DiscordIdSchema).max(25).optional(),
        /** Writable text channels in the connected server, for the account page's picker. */
        availableChannels: z
          .array(z.object({ id: DiscordIdSchema, name: z.string().max(100) }).strict())
          .max(500)
          .nullable()
          .optional(),
        wakeTrigger: DiscordWakeTriggerSchema.optional(),
        since: z.string().optional(),
      })
      .strict(),
    usage: z.array(OfficialDiscordLimitUsageSchema).max(16).optional(),
  })
  .strict();
export type OfficialDiscordStatus = z.infer<typeof OfficialDiscordStatusSchema>;

/**
 * This machine's official-bot route, served by the body (VUH-1766). The app and
 * `clankie discord official` read and change it here: GET with observe access,
 * POST with operator (Take Control) access. Node-free, so the app can import it.
 */
export const OFFICIAL_DISCORD_BODY_PATH = "/v1/discord/official";

export const OfficialDiscordBodyStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** The saved `discord.officialBotEnabled` setting. */
    enabled: z.boolean(),
    /** Registered with the account and accepting deliveries in this running service. */
    running: z.boolean(),
    /** This machine is signed in to a Clankie account (`clankie remote-access on`). */
    signedIn: z.boolean(),
    /** Where to finish Add to Discord, in a browser signed in to the same account. */
    installUrl: z.string().url().optional(),
    /** What the hosted fleet reports: registration, server, block and usage against limits. */
    official: OfficialDiscordStatusSchema.optional(),
    /** Why the fleet's report is missing, such as `not_signed_in` or the fleet's error code. */
    fleetError: z.string().min(1).max(200).optional(),
    /** The owner's next step, in plain words. */
    next: z.string().min(1).max(500).optional(),
  })
  .strict();
export type OfficialDiscordBodyStatus = z.infer<typeof OfficialDiscordBodyStatusSchema>;

export const OfficialDiscordBodyUpdateSchema = z.object({ enabled: z.boolean() }).strict();
export type OfficialDiscordBodyUpdate = z.infer<typeof OfficialDiscordBodyUpdateSchema>;

/** Why turning the official bot on was refused; nothing was changed. */
export const OfficialDiscordBodyRefusalSchema = z
  .object({
    error: z.enum([
      "not_signed_in",
      /** This machine's own Discord bot is the official application: one gateway connection per token. */
      "official_application_is_local_bot",
      "fleet_unavailable",
    ]),
    detail: z.string().min(1).max(500),
  })
  .strict();
export type OfficialDiscordBodyRefusal = z.infer<typeof OfficialDiscordBodyRefusalSchema>;
