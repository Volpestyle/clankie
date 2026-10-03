import { z } from "zod";

export const BodyResourceSchema = z.enum(["discord_mouth", "voice", "browser", "play"]);
export type BodyResource = z.infer<typeof BodyResourceSchema>;
const conversationId = z.string().trim().min(1).max(512);
const incarnation = z.uuid();
const ttlMs = z.number().int().min(1).max(300_000);

/** Public inspection contains attribution, never the capability's incarnation. */
export const BodyLeaseViewSchema = z.strictObject({
  resource: BodyResourceSchema,
  conversationId,
  state: z.enum(["active", "recovery_required"]),
  expiresAt: z.number().int().nonnegative(),
});
export type BodyLeaseView = z.infer<typeof BodyLeaseViewSchema>;

/** A requested conversation is verified against host route identity before use. */
export const BodyLeaseRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("acquire"), resource: BodyResourceSchema, conversationId, ttlMs }),
  z.strictObject({
    action: z.literal("renew"),
    resource: BodyResourceSchema,
    conversationId,
    incarnation,
    ttlMs,
  }),
  z.strictObject({ action: z.literal("release"), resource: BodyResourceSchema, conversationId, incarnation }),
  z.strictObject({
    action: z.literal("queue"),
    resource: BodyResourceSchema,
    conversationId,
    request: z.string().trim().min(1).max(2_000),
    ttlMs,
  }),
  z.strictObject({
    action: z.literal("ask"),
    resource: BodyResourceSchema,
    conversationId,
    request: z.string().trim().min(1).max(2_000),
    ttlMs,
  }),
  z.strictObject({ action: z.literal("recover"), resource: BodyResourceSchema, conversationId }),
]);
export type BodyLeaseRequest = z.infer<typeof BodyLeaseRequestSchema>;

export const BodyLeaseResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("acquired"), lease: BodyLeaseViewSchema, incarnation }),
  z.strictObject({ outcome: z.literal("renewed"), lease: BodyLeaseViewSchema }),
  z.strictObject({ outcome: z.literal("released") }),
  z.strictObject({
    outcome: z.literal("busy"),
    lease: BodyLeaseViewSchema,
    actions: z.array(z.enum(["queue", "ask"])),
  }),
  z.strictObject({
    outcome: z.literal("queued"),
    requestId: z.uuid(),
    expiresAt: z.number().int().nonnegative(),
  }),
  z.strictObject({
    outcome: z.literal("asked"),
    requestId: z.uuid(),
    deliveryStage: z.enum([
      "stored",
      "delivered",
      "consumed",
      "responded",
      "unavailable",
      "uncertain",
      "expired",
      "rejected",
    ]),
  }),
  z.strictObject({
    outcome: z.literal("rejected"),
    reason: z.enum([
      "identity_required",
      "not_authorized",
      "stale_lease",
      "recovery_required",
      "store_unavailable",
      "queue_full",
      "unavailable",
    ]),
  }),
]);
export type BodyLeaseResult = z.infer<typeof BodyLeaseResultSchema>;

/** Resolved by the authenticated gateway body, never supplied by a model tool. */
export const BodyVoiceTargetSchema = z.strictObject({
  guildId: z.string().min(1).max(128),
  channelId: z.string().min(1).max(128),
  actorId: z.string().min(1).max(128),
  presenceSessionId: z.string().min(1).max(128),
  transportKind: z.enum(["bot", "user_session"]),
});
export type BodyVoiceTarget = z.infer<typeof BodyVoiceTargetSchema>;
export const BodyVoiceStaySchema = z.strictObject({
  target: BodyVoiceTargetSchema,
  kind: z.enum(["audio", "publish"]).optional(),
  stayId: z.uuid(),
  generation: z.number().int().nonnegative(),
});
export type BodyVoiceStay = z.infer<typeof BodyVoiceStaySchema>;
export const BodyVoiceLeaseRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("claim"), stay: BodyVoiceStaySchema, ticket: z.uuid().optional() }),
  z.strictObject({ action: z.literal("heartbeat"), stay: BodyVoiceStaySchema, incarnation }),
  z.strictObject({ action: z.literal("finish"), stay: BodyVoiceStaySchema, incarnation }),
]);
export type BodyVoiceLeaseRequest = z.infer<typeof BodyVoiceLeaseRequestSchema>;

export const BODY_LEASE_STATUS_PATH = "/v1/body-leases";
export const BodyLeaseStatusSchema = z.strictObject({ leases: z.array(BodyLeaseViewSchema).max(4) });
export type BodyLeaseStatus = z.infer<typeof BodyLeaseStatusSchema>;

export const BodyVoiceSubjectSchema = z.strictObject({
  characterId: z.string().min(1).max(128),
  credentialRef: z.string().min(1).max(128),
  transportKind: z.enum(["bot", "user_session"]),
});
export type BodyVoiceSubject = z.infer<typeof BodyVoiceSubjectSchema>;

/** Internal authenticated host-to-body reconciliation, never a tool argument. */
export const BodyVoiceReconcileRequestSchema = z.strictObject({
  subject: BodyVoiceSubjectSchema,
  nonce: z.uuid(),
  stays: z.array(BodyVoiceStaySchema).min(1).max(128),
});
export type BodyVoiceReconcileRequest = z.infer<typeof BodyVoiceReconcileRequestSchema>;
export const BodyVoiceReconcileResultSchema = z.strictObject({
  subject: BodyVoiceSubjectSchema,
  nonce: z.uuid(),
  presenceSessionId: z.string().min(1).max(128),
  confirmedStayIds: z.array(z.uuid()).max(128),
});
export type BodyVoiceReconcileResult = z.infer<typeof BodyVoiceReconcileResultSchema>;

export const BodyVoiceReconcileGuardSchema = BodyVoiceReconcileRequestSchema.extend({
  presenceSessionId: z.string().min(1).max(128),
});
export type BodyVoiceReconcileGuard = z.infer<typeof BodyVoiceReconcileGuardSchema>;
