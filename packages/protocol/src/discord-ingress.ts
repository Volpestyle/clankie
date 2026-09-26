import { createHash } from "node:crypto";
import { z } from "zod";
import { DiscordPresenceAttachmentSchema } from "./index.ts";

/** Trusted connection ingress, never an operator or general-purpose captain bearer. */
export const DISCORD_INGRESS_PATH = "/v1/discord/ingress";
export const DISCORD_INGRESS_DOMAIN = "clankie-discord-ingress-v1";
export const DiscordIdSchema = z.string().regex(/^[0-9]{1,20}$/u);
const Encoded32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
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
    kind: z.enum(["mention", "dm", "reply", "slash"]),
    content: z.string().max(16_384),
    attachments: z.array(DiscordPresenceAttachmentSchema).max(4).default([]),
  })
  .strict()
  .refine((e) => e.expiresAtMs > e.eventAtMs && e.expiresAtMs - e.eventAtMs <= 300_000)
  .refine((e) => e.content.trim().length > 0 || e.attachments.length > 0)
  .refine((e) => (e.kind === "dm") === (e.guildId === undefined));
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
  z.object({ state: z.literal("reply"), text: z.string().min(1).max(16_384) }).strict(),
  z.object({ state: z.literal("silent") }).strict(),
  z.object({ state: z.literal("pending") }).strict(),
  z.object({ state: z.literal("failed"), code: z.enum(["interrupted", "unavailable"]) }).strict(),
]);
export type DiscordIngressResult = z.infer<typeof DiscordIngressResultSchema>;
