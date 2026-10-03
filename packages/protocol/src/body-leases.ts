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
