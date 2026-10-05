import { z } from "zod";
import { DiscordDirectoryRequestSchema } from "./discord-directory.ts";
import { DiscordConnectionGenerationSchema } from "./managed-discord.ts";

export const HOSTED_DISCORD_DOMAIN = "clankie-hosted-discord-v1";
export const HOSTED_DISCORD_PERMIT_TTL_SECONDS = 30;
/** Only canonical Discord routes; queries are admitted exclusively by the directory schema. */
export function hostedDiscordAllows(method: string, path: string): boolean {
  if (path === "/v1/discord/settings") return method === "GET" || method === "POST";
  if (method !== "GET" || path.length > 2048 || !/^\/v1\/discord\/directory(?:\?|$)/u.test(path))
    return false;
  const url = new URL(path, "http://control");
  if (url.hash || url.pathname !== "/v1/discord/directory") return false;
  const keys = [...url.searchParams.keys()];
  if (
    keys.some((key) => !["kind", "guildId", "limit", "after"].includes(key)) ||
    new Set(keys).size !== keys.length
  )
    return false;
  return DiscordDirectoryRequestSchema.safeParse(Object.fromEntries(url.searchParams)).success;
}
const Point = z.string().regex(/^[A-Za-z0-9_-]{87}$/u);
export const HostedDiscordTargetSchema = z.object({
  tenantId: z.string().regex(/^tn_[a-z2-7]{20}$/u),
  installationId: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
  publicKey: Point,
});
export const HostedDiscordRequestSchema = HostedDiscordTargetSchema.omit({ publicKey: true })
  .extend({
    method: z.enum(["GET", "POST"]),
    path: z.string().min(1).max(2048),
    ephemeralPublicKey: Point,
    nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
    sealed: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/u)
      .min(38)
      .max(65536),
  })
  .strict();
export type HostedDiscordRequest = z.infer<typeof HostedDiscordRequestSchema>;
export const HostedDiscordEnvelopeSchema = HostedDiscordRequestSchema.extend({
  permit: z.string().max(4096),
}).strict();
export const HostedDiscordHeaderSchema = z
  .object({
    alg: z.literal("EdDSA"),
    typ: z.literal("clankie-discord-web"),
    kid: z.string().regex(/^[A-Za-z0-9_-]{16}$/u),
  })
  .strict();
export const HostedDiscordClaimsSchema = z
  .object({
    iss: z.literal("clankie-fleet"),
    aud: z.literal("clankie-body"),
    tid: HostedDiscordTargetSchema.shape.tenantId,
    inst: HostedDiscordTargetSchema.shape.installationId,
    sub: z.string().min(1).max(128),
    gen: DiscordConnectionGenerationSchema,
    dig: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    jti: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
    iat: z.number().int().positive(),
    exp: z.number().int().positive(),
  })
  .strict();
export const HostedDiscordAuthorizeRequestSchema = z
  .object({
    installationId: HostedDiscordTargetSchema.shape.installationId,
    permit: z.string().min(1).max(4096),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
  })
  .strict();
export const HostedDiscordAuthorizationHeaderSchema = HostedDiscordHeaderSchema.extend({
  typ: z.literal("clankie-discord-authorization"),
}).strict();
export const HostedDiscordAuthorizationClaimsSchema = HostedDiscordClaimsSchema.extend({
  typ: z.literal("clankie-discord-authorization"),
  prm: HostedDiscordClaimsSchema.shape.jti,
  non: HostedDiscordAuthorizeRequestSchema.shape.nonce,
})
  .omit({ jti: true })
  .strict();
export function hostedDiscordContext(target: { tenantId: string; installationId: string }): string {
  return `${HOSTED_DISCORD_DOMAIN}\n${target.tenantId}\n${target.installationId}`;
}
export function hostedDiscordRequestTranscript(request: HostedDiscordRequest): string {
  return JSON.stringify([
    HOSTED_DISCORD_DOMAIN,
    request.tenantId,
    request.installationId,
    request.method,
    request.path,
    request.ephemeralPublicKey,
    request.nonce,
    request.sealed,
  ]);
}
export const HostedDiscordPlainRequestSchema = z
  .object({ path: z.string().min(1).max(2048).optional(), body: z.string().max(32768).optional() })
  .strict();
export const HostedDiscordResponseSchema = z.object({
  status: z.number().int().min(200).max(599),
  body: z.string().max(2 * 1024 * 1024),
});
