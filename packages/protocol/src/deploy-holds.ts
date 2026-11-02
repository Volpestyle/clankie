import { z } from "zod";

const Id = z.uuid();
const Text = z.string().trim().min(1).max(512);
export const HoldOverrideSchema = z.object({ holdId: Id, actor: Text, reason: Text }).strict();
export type HoldOverride = z.infer<typeof HoldOverrideSchema>;
/** A deploy hold protects the running service for at most an hour (VUH-2049). */
export const DEPLOY_HOLD_MAX_MINUTES = 60;
/** The runtime canary's own holds end with their canary, not on a clock. */
export const RUNTIME_CANARY_HOLDER = "Clankie runtime canary";

export const DEPLOY_HOLDS_PATH = "/v1/deploy-holds";
export const DeployHoldRequestSchema = z.union([
  z.object({ action: z.literal("list") }).strict(),
  z
    .object({
      action: z.literal("hold"),
      id: Id,
      holder: Text,
      reason: Text,
      minutes: z.number().int().min(1).max(DEPLOY_HOLD_MAX_MINUTES),
      pane: Text.optional(),
      seat: Text.optional(),
    })
    .strict(),
  z.object({ action: z.literal("release"), id: Id, actor: Text, reason: Text }).strict(),
]);
export type DeployHoldRequest = z.infer<typeof DeployHoldRequestSchema>;

export const DeployHoldSchema = z.object({
  id: Id,
  holder: Text,
  reason: Text,
  createdAt: z.iso.datetime(),
  /** Absent only on the runtime canary's holds and on holds placed before VUH-2049. */
  expiresAt: z.iso.datetime().optional(),
  pane: Text.optional(),
  seat: Text.optional(),
  presence: z.enum(["present", "gone", "unknown", "person"]),
});
export type DeployHold = z.infer<typeof DeployHoldSchema>;
/** A durable record of a hold ending or being passed over: who held it, who acted, why and when. */
export const DeployHoldReceiptSchema = z.object({
  action: z.enum(["release", "override", "expire"]),
  hold: DeployHoldSchema,
  actor: z.string(),
  reason: z.string(),
  at: z.iso.datetime(),
  operation: z.string(),
});
export type DeployHoldReceipt = z.infer<typeof DeployHoldReceiptSchema>;

/** When the hold lifts on its own; undefined only for the runtime canary's holds. */
export function deployHoldExpiry(
  hold: Pick<DeployHold, "holder" | "createdAt" | "expiresAt" | "pane" | "seat">,
) {
  if (hold.expiresAt) return Date.parse(hold.expiresAt);
  if (hold.holder === RUNTIME_CANARY_HOLDER && !hold.pane && !hold.seat) return undefined;
  return Date.parse(hold.createdAt) + DEPLOY_HOLD_MAX_MINUTES * 60_000;
}

function span(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 120 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

/** "Saga w3Z:p2N: release gate (held 42m, 18m left)": holder, age and time left in one line. */
export function describeDeployHold(hold: DeployHold, now = Date.now()): string {
  const expiry = deployHoldExpiry(hold);
  const left =
    expiry === undefined ? "until its canary ends or the owner releases it" : `${span(expiry - now)} left`;
  return `${hold.holder}: ${hold.reason} (held ${span(now - Date.parse(hold.createdAt))}, ${left})`;
}
export const DeployHoldResponseSchema = z.object({
  ok: z.boolean(),
  holds: z.array(DeployHoldSchema).optional(),
  receipts: z.array(DeployHoldReceiptSchema).optional(),
  error: z.string().optional(),
});
export type DeployHoldResponse = z.infer<typeof DeployHoldResponseSchema>;
