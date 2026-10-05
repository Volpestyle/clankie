import { z } from "zod";

export const MinecraftHostUsernameSchema = z.string().regex(/^[A-Za-z0-9_]{3,16}$/u);
const hasControls = (value: string) =>
  [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const text = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !hasControls(value));
const booleanRule = z.enum([
  "doDaylightCycle",
  "doWeatherCycle",
  "keepInventory",
  "mobGriefing",
  "doMobSpawning",
  "doFireTick",
  "doTileDrops",
  "doEntityDrops",
  "doInsomnia",
  "announceAdvancements",
  "showDeathMessages",
  "naturalRegeneration",
  "reducedDebugInfo",
  "sendCommandFeedback",
]);
export const MinecraftHostAdminCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("whitelist_add"), username: MinecraftHostUsernameSchema }),
  z.strictObject({ operation: z.literal("whitelist_remove"), username: MinecraftHostUsernameSchema }),
  z.strictObject({
    operation: z.literal("kick"),
    username: MinecraftHostUsernameSchema,
    reason: text.optional(),
  }),
  z.strictObject({
    operation: z.literal("ban"),
    username: MinecraftHostUsernameSchema,
    reason: text.optional(),
  }),
  z.strictObject({ operation: z.literal("pardon"), username: MinecraftHostUsernameSchema }),
  z.strictObject({ operation: z.literal("gamerule"), rule: booleanRule, value: z.boolean() }),
  z.strictObject({
    operation: z.literal("time"),
    value: z.union([
      z.enum(["day", "night", "noon", "midnight"]),
      z.number().int().nonnegative().max(24_000),
    ]),
  }),
  z.strictObject({
    operation: z.literal("weather"),
    value: z.enum(["clear", "rain", "thunder"]),
    durationSeconds: z.number().int().positive().max(86_400).optional(),
  }),
  z.strictObject({
    operation: z.literal("gamemode"),
    username: MinecraftHostUsernameSchema,
    value: z.enum(["survival", "creative", "adventure", "spectator"]),
  }),
  z.strictObject({ operation: z.literal("say"), text }),
  z.strictObject({ operation: z.literal("tell"), username: MinecraftHostUsernameSchema, text }),
  z.strictObject({ operation: z.literal("list") }),
]);
export type MinecraftHostAdminCommand = z.infer<typeof MinecraftHostAdminCommandSchema>;

export const MinecraftHostSettingsSchema = z.strictObject({
  backend: z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("local") }),
      z.strictObject({
        kind: z.literal("aws-ec2"),
        accountId: z.string().regex(/^\d{12}$/u),
        instanceId: z.string().regex(/^i-[0-9a-f]{17}$/u),
        region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/u),
      }),
    ])
    .optional(),
  gamePort: z.number().int().min(1024).max(65535),
  rconPort: z.number().int().min(1024).max(65535),
  java: z
    .string()
    .min(1)
    .max(1024)
    .refine((value) => value.startsWith("/") && !hasControls(value))
    .optional(),
  memoryMiB: z.number().int().min(512).max(8192),
  backupIntervalMs: z.number().int().min(60_000).max(86_400_000),
  backupRetention: z.number().int().min(1).max(30),
  idleTimeoutMs: z.number().int().min(100).max(900_000),
  maxUptimeMs: z.number().int().min(100).max(86_400_000),
});
export type MinecraftHostSettings = z.infer<typeof MinecraftHostSettingsSchema>;

/** Stable public diagnostics only; upstream response bodies and credentials stay private. */
export const MinecraftTunnelErrorSchema = z.enum([
  "playit-auth-not-ready",
  "playit-credential-invalid",
  "playit-tunnel-unsafe",
  "playit-tunnel-allocation-pending",
  "playit-platform-not-supported",
  "playit-install-required",
  "playit-start-failed",
  "playit-process-error",
  "playit-agent-exited",
  "playit-health-unverified",
  "playit-stop-unconfirmed",
  "playit-api-unavailable",
  "playit-api-invalid-response",
  "playit-api-invalid-request",
  "playit-agent-version-too-old",
  "playit-email-verification-required",
  "playit-api-rejected",
]);
export type MinecraftTunnelError = z.infer<typeof MinecraftTunnelErrorSchema>;

/** Transient owner claim only; permanent playit credentials never leave the broker. */
export const MinecraftTunnelClaimStatusSchema = z.strictObject({
  phase: z.enum(["idle", "preparing", "pending", "claimed", "expired", "rejected", "failed"]),
  claimed: z.boolean(),
  claimUrl: z
    .string()
    .regex(/^https:\/\/playit\.gg\/claim\/[a-f0-9]{10}$/u)
    .optional(),
  expiresAt: z.iso.datetime().optional(),
  error: z.enum(["playit-install-failed", "playit-claim-unavailable"]).optional(),
});
export type MinecraftTunnelClaimStatus = z.infer<typeof MinecraftTunnelClaimStatusSchema>;

/** Operator API; Discord subjects are captured by the host, never supplied in commands. */
export const MinecraftHostCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("configuration") }),
  z.strictObject({ action: z.literal("configure"), settings: MinecraftHostSettingsSchema.partial() }),
  z.strictObject({ action: z.literal("status") }),
  z.strictObject({ action: z.literal("start") }),
  z.strictObject({ action: z.literal("stop") }),
  z.strictObject({ action: z.literal("restart") }),
  z.strictObject({ action: z.literal("backup") }),
  z.strictObject({ action: z.literal("claim") }),
  z.strictObject({ action: z.literal("claim_complete") }),
  z.strictObject({ action: z.literal("claim_status") }),
  z.strictObject({ action: z.literal("admin"), command: MinecraftHostAdminCommandSchema }),
  z.strictObject({ action: z.literal("request_enrollment"), username: MinecraftHostUsernameSchema }),
  z.strictObject({ action: z.literal("approve_enrollment"), username: MinecraftHostUsernameSchema }),
]);
export type MinecraftHostCommand = z.infer<typeof MinecraftHostCommandSchema>;
