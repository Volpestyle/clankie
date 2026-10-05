import { z } from "zod";

export const SUPPORT_GRANTS_PATH = "/v1/support/grants";
export const HOSTED_SUPPORT_PATH = "/v1/hosted/support";
export const HOSTED_SUPPORT_DOMAIN = "clankie-hosted-support-v1";
export const SUPPORT_GRANT_MAX_SECONDS = 72 * 60 * 60;
export const SUPPORT_GRANT_WINDOW_CAPACITY = 1024;
export const SupportGrantIdSchema = z.string().uuid();
export const SupportGrantScopeSchema = z.enum(["read-state", "shell"]);
export const SupportGrantStatusSchema = z.enum(["active", "revoked", "expired"]);
export const SupportGrantCreateRequestSchema = z
  .object({
    scope: SupportGrantScopeSchema,
    durationSeconds: z.number().int().min(1).max(SUPPORT_GRANT_MAX_SECONDS),
    supportRef: z.string().trim().min(1).max(128),
  })
  .strict();
export type SupportGrantCreateRequest = z.infer<typeof SupportGrantCreateRequestSchema>;

/** Customer reference remains body-side and in sealed owner responses, never telemetry or fleet sync. */
export const SupportGrantMetadataSchema = z
  .object({
    grantId: SupportGrantIdSchema,
    scope: SupportGrantScopeSchema,
    status: SupportGrantStatusSchema,
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    revokedAt: z.string().datetime().optional(),
  })
  .strict()
  .refine((grant) => {
    const duration = Date.parse(grant.expiresAt) - Date.parse(grant.createdAt);
    return (
      duration > 0 &&
      duration <= SUPPORT_GRANT_MAX_SECONDS * 1000 &&
      (grant.status === "revoked" ? grant.revokedAt !== undefined : grant.revokedAt === undefined)
    );
  }, "Invalid support grant lifetime or terminal state");
export type SupportGrantMetadata = z.infer<typeof SupportGrantMetadataSchema>;
export const SupportGrantSchema = SupportGrantMetadataSchema.safeExtend({
  supportRef: SupportGrantCreateRequestSchema.shape.supportRef,
}).strict();
export type SupportGrant = z.infer<typeof SupportGrantSchema>;
export const SupportGrantListResponseSchema = z.object({ grants: z.array(SupportGrantSchema) }).strict();
export type SupportGrantListResponse = z.infer<typeof SupportGrantListResponseSchema>;

export const SupportAccessCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  SupportGrantCreateRequestSchema.extend({ action: z.literal("create") }).strict(),
  z.object({ action: z.literal("revoke"), grantId: SupportGrantIdSchema }).strict(),
  z.object({ action: z.literal("pairing-offer"), grantId: SupportGrantIdSchema }).strict(),
]);
export type SupportAccessCommand = z.infer<typeof SupportAccessCommandSchema>;
export const HostedSupportRequestSchema = z
  .object({
    version: z.literal(1),
    supportTicket: z.string().min(1).max(4096),
    browserPublicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/u),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
    command: SupportAccessCommandSchema,
  })
  .strict();
export type HostedSupportRequest = z.infer<typeof HostedSupportRequestSchema>;
export const SupportGrantSyncSchema = z
  .object({
    schemaVersion: z.literal(1),
    installationId: z.string().min(1).max(128),
    revision: z.number().int().nonnegative(),
    grants: z.array(SupportGrantMetadataSchema).max(SUPPORT_GRANT_WINDOW_CAPACITY),
  })
  .strict();
export type SupportGrantSync = z.infer<typeof SupportGrantSyncSchema>;

/** Closed classes only; request paths, query strings, content and support references cannot enter audit. */
export const SupportRouteClassSchema = z.enum(["device-state", "device-session", "body-state", "other"]);
export type SupportRouteClass = z.infer<typeof SupportRouteClassSchema>;
export const SUPPORT_DEVICE_GRANTS = {
  chat: false,
  steer: false,
  terminalObserve: false,
  terminalControl: false,
} as const;

/** Pairing reads conversation state/history. Shell grants authorize the fleet's separate shell path. */
export function supportReadOperationAllowed(op: string, scope: "read-state" | "shell"): boolean {
  return (
    scope === "read-state" &&
    ["list", "get", "replay", "tail", "presence", "roster", "fleet", "composer_catalog"].includes(op)
  );
}
