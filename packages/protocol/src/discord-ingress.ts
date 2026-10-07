import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CaptainChannelTurnResultSchema,
  DiscordPresenceAttachmentSchema,
  DiscordPresenceChannelTurnRequestSchema,
} from "./index.ts";

/** Trusted connection ingress, never an operator or general-purpose captain bearer. */
export const DISCORD_INGRESS_PATH = "/v1/discord/ingress";
export const DISCORD_INGRESS_DOMAIN = "clankie-discord-ingress-v1";
export const DiscordIdSchema = z.string().regex(/^[0-9]{1,20}$/u);
/** Recent channel messages a connection buffered before the trigger (VUH-1765). */
export const DISCORD_INGRESS_CONTEXT_MAX = 20;
export const DISCORD_INGRESS_CONTEXT_BODY_MAX = 2_000;
export const DiscordIngressContextMessageSchema = z
  .object({
    messageId: DiscordIdSchema,
    actorId: DiscordIdSchema,
    content: z.string().min(1).max(DISCORD_INGRESS_CONTEXT_BODY_MAX),
    atMs: z.number().int().nonnegative(),
  })
  .strict();
export type DiscordIngressContextMessage = z.infer<typeof DiscordIngressContextMessageSchema>;
/**
 * What wakes a body for ordinary channel chat (VUH-1765): `addressed` is a
 * mention, DM, reply or slash command; `name` adds his name in a message;
 * `any` lets every admitted message reach him so he decides for himself.
 */
export const DiscordWakeTriggerSchema = z.enum(["addressed", "name", "any"]);
export type DiscordWakeTrigger = z.infer<typeof DiscordWakeTriggerSchema>;
const Encoded32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
/** Connection-owned voice RPCs carry no credential or general operator authority. */
export const DiscordIngressVoiceSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("briefing"), consentedUserIds: z.array(DiscordIdSchema).max(25) }).strict(),
  z.object({ action: z.literal("handoff"), request: DiscordPresenceChannelTurnRequestSchema }).strict(),
  z
    .object({
      action: z.literal("self_tool"),
      tool: z.enum(["recall_episodes", "get_self_state", "remember_episode"]),
      arguments: z.record(z.string(), z.unknown()),
    })
    .strict(),
]);
export const DiscordIngressEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    tenantId: z.string().regex(/^tn_[a-z2-7]{20}$/u),
    installationId: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
    deliveryId: z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/u),
    eventAtMs: z.number().int().nonnegative(),
    expiresAtMs: z.number().int().positive(),
    guildId: DiscordIdSchema.optional(),
    channelId: DiscordIdSchema,
    messageId: DiscordIdSchema,
    actorId: DiscordIdSchema,
    /** Asserted only by the authenticated connection, never by message content. */
    owner: z.boolean(),
    /** `message` is unaddressed chat admitted by the `name` or `any` wake trigger. */
    kind: z.enum(["mention", "dm", "reply", "slash", "voice", "message"]),
    voice: DiscordIngressVoiceSchema.optional(),
    content: z.string().max(16_384),
    attachments: z.array(DiscordPresenceAttachmentSchema).max(4).default([]),
    /** Buffered channel messages before this one, oldest first. Never a trigger. */
    context: z.array(DiscordIngressContextMessageSchema).max(DISCORD_INGRESS_CONTEXT_MAX).optional(),
  })
  .strict()
  .refine((e) => e.expiresAtMs > e.eventAtMs && e.expiresAtMs - e.eventAtMs <= 300_000)
  .refine((e) => e.content.trim().length > 0 || e.attachments.length > 0)
  .refine((e) => (e.kind === "dm") === (e.guildId === undefined))
  .refine((e) => (e.kind === "voice") === (e.voice !== undefined))
  .refine((e) => e.kind !== "message" || e.guildId !== undefined)
  .refine((e) => e.context === undefined || e.kind !== "voice")
  .refine((e) => {
    if (e.voice?.action !== "handoff") return true;
    const r = e.voice.request;
    return (
      r.trigger.kind === "voice_event" &&
      r.trigger.guildId === e.guildId &&
      r.trigger.channelId === e.channelId &&
      r.trigger.actorId === e.actorId &&
      r.identity.transportKind === "bot" &&
      r.identity.credentialRef === "hosted_discord"
    );
  });
export type DiscordIngressEvent = z.infer<typeof DiscordIngressEventSchema>;
export function discordEventDigest(event: DiscordIngressEvent): string {
  return createHash("sha256")
    .update(JSON.stringify(DiscordIngressEventSchema.parse(event)))
    .digest("base64url");
}
/** Bind the response recipient too: a relay must not re-encrypt known text to its own key. */
export function discordRequestDigest(
  event: DiscordIngressEvent,
  ephemeralPublicKey: string,
  nonce: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        DISCORD_INGRESS_DOMAIN,
        DiscordIngressEventSchema.parse(event),
        ephemeralPublicKey,
        nonce,
      ]),
    )
    .digest("base64url");
}
export const DiscordPermitHeaderSchema = z
  .object({
    alg: z.literal("EdDSA"),
    typ: z.literal("clankie-discord"),
    kid: z.string().regex(/^[A-Za-z0-9_-]{16}$/u),
  })
  .strict();
export const DiscordPermitClaimsSchema = z
  .object({
    typ: z.literal("clankie-discord"),
    aud: z.literal("clankie-body"),
    iss: z.literal("clankie-fleet"),
    tid: z.string().regex(/^tn_[a-z2-7]{20}$/u),
    inst: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
    dig: Encoded32,
    jti: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict();
export const DiscordIngressEnvelopeSchema = z
  .object({
    version: z.literal(1),
    permit: z.string().min(1).max(4096),
    ephemeralPublicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/u),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
    sealed: z
      .string()
      .min(40)
      .max(100_000)
      .regex(/^[A-Za-z0-9_-]+$/u),
  })
  .strict();
export type DiscordIngressEnvelope = z.infer<typeof DiscordIngressEnvelopeSchema>;
export const DiscordIngressResultSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("voice"),
      result: z.union([
        z.object({ instructions: z.string().max(12_000), briefing: z.string().max(8_000) }).strict(),
        CaptainChannelTurnResultSchema,
        z.object({ text: z.string().max(2_000), isError: z.boolean() }).strict(),
      ]),
    })
    .strict(),
  z.object({ state: z.literal("reply"), text: z.string().min(1).max(16_384) }).strict(),
  z.object({ state: z.literal("silent") }).strict(),
  z.object({ state: z.literal("pending") }).strict(),
  z.object({ state: z.literal("failed"), code: z.enum(["interrupted", "unavailable"]) }).strict(),
]);
export type DiscordIngressResult = z.infer<typeof DiscordIngressResultSchema>;
