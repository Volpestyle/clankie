import { CheckoutSyncResultSchema } from "./checkouts.ts";
import { z } from "zod";

export const INTEGRATE_PATH = "/v1/integrate";
const Id = z.uuid();
const Sha = z.string().regex(/^[a-f0-9]{40,64}$/u);
const Commit = z.string().regex(/^[a-f0-9]{7,64}$/u);
const Text = z.string().trim().min(1).max(512);
export const HoldOverrideSchema = z.object({ holdId: Id, actor: Text, reason: Text }).strict();
export type HoldOverride = z.infer<typeof HoldOverrideSchema>;
/** A deploy hold protects the running service for at most an hour (VUH-2049). */
export const DEPLOY_HOLD_MAX_MINUTES = 60;
/** The runtime canary's own holds end with their canary, not on a clock. */
export const RUNTIME_CANARY_HOLDER = "Clankie runtime canary";

export const IntegrationRunSchema = z
  .object({
    action: z.literal("run"),
    id: Id,
    core: z.array(Commit).max(100).default([]),
    app: z.array(Commit).max(100).optional(),
    restore: Id.optional(),
    push: z.boolean().default(false),
  })
  .strict()
  .refine(
    (r) =>
      r.restore ? r.core.length === 0 && r.app === undefined : r.core.length + (r.app?.length ?? 0) > 0,
    "Supply approved commits, or a passed batch to restore",
  );
export type IntegrationRun = z.infer<typeof IntegrationRunSchema>;
// Records from before VUH-2049 carry the hold overrides landing once took; holds no longer gate landing.
const RecordedRunSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || !("overrides" in value)) return value;
  const rest: Record<string, unknown> = { ...value };
  delete rest.overrides;
  return rest;
}, IntegrationRunSchema);
export const IntegrationRequestSchema = z.union([
  IntegrationRunSchema,
  z.object({ action: z.literal("status"), id: Id.optional() }).strict(),
  z.object({ action: z.literal("push"), id: Id }).strict(),
  z.object({ action: z.literal("cancel"), id: Id, actor: Text, reason: Text }).strict(),
  z.object({ action: z.literal("holds") }).strict(),
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
export type IntegrationRequest = z.infer<typeof IntegrationRequestSchema>;

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
const CommandRecordSchema = z.object({
  head: Sha,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  log: z.string(),
});
const IntegrationRepoSchema = z.object({
  name: z.enum(["core", "app"]),
  source: z.string(),
  ownerCheckoutSync: CheckoutSyncResultSchema.optional(),
  origin: z.string(),
  base: Sha,
  directory: z.string(),
  head: Sha,
  commits: z.array(
    z.object({
      commit: Commit,
      memberId: Id.optional(),
      state: z.enum(["pending", "applied", "already_present", "conflict", "blocked", "failed"]),
      head: Sha.optional(),
      conflicts: z.array(z.string()).optional(),
      error: z.string().optional(),
    }),
  ),
  install: CommandRecordSchema.optional(),
  gate: CommandRecordSchema.optional(),
  /**
   * Each move onto a newer origin/main after the gate: the incoming commits it checked and
   * whether the recorded selection still covered the rebased HEAD (VUH-2068).
   */
  revalidations: z
    .array(
      z.object({
        from: Sha,
        to: Sha,
        incoming: z.array(Sha),
        previousHead: Sha,
        head: Sha.optional(),
        covered: z.boolean(),
        reason: z.string().optional(),
        exitCode: z.number().int().nullable().optional(),
        log: z.string().optional(),
        at: z.iso.datetime(),
      }),
    )
    .optional(),
  push: z
    .object({
      state: z.enum(["attempting", "confirmed", "rejected", "unconfirmed"]),
      at: z.iso.datetime(),
      exitCode: z.number().int().nullable(),
      log: z.string(),
    })
    .optional(),
});
export type IntegrationRepo = z.infer<typeof IntegrationRepoSchema>;
export const IntegrationBatchSchema = z.object({
  schemaVersion: z.literal(1),
  id: Id,
  request: RecordedRunSchema,
  state: z.enum([
    "queued",
    "composing",
    "conflict",
    "installing",
    "gating",
    "isolating",
    "failed",
    "passed",
    "held",
    "pushing",
    "pushed",
    "partial",
    "interrupted",
    "cancelled",
  ]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  evidence: z.string(),
  repos: z.array(IntegrationRepoSchema),
  error: z.string().optional(),
  // Request receipts retain their original input and point to the shared attestation.
  batchId: Id.optional(),
  attempts: z.array(Id).optional(),
  members: z.array(RecordedRunSchema).optional(),
  excluded: z
    .array(z.object({ id: Id, state: z.enum(["conflict", "failed"]), error: z.string() }))
    .optional(),
  /** Why the queue gates these requests again: main moved somewhere the held attempt's gate checked. */
  regateReason: z.string().optional(),
  /** Who withdrew a request before its gate started, and why. */
  cancelled: z.object({ actor: Text, reason: Text, at: z.iso.datetime() }).optional(),
});
export type IntegrationBatch = z.infer<typeof IntegrationBatchSchema>;
export const IntegrationQueueStatusSchema = z.object({
  running: z.array(IntegrationBatchSchema),
  waiting: z.array(IntegrationBatchSchema),
  lastResult: IntegrationBatchSchema.optional(),
  interrupted: z.array(IntegrationBatchSchema),
});
export type IntegrationQueueStatus = z.infer<typeof IntegrationQueueStatusSchema>;
export const IntegrationResponseSchema = z.object({
  ok: z.boolean(),
  batch: IntegrationBatchSchema.optional(),
  holds: z.array(DeployHoldSchema).optional(),
  receipts: z.array(DeployHoldReceiptSchema).optional(),
  queue: IntegrationQueueStatusSchema.optional(),
  error: z.string().optional(),
});
export type IntegrationResponse = z.infer<typeof IntegrationResponseSchema>;
