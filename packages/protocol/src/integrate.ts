import { z } from "zod";

export const INTEGRATE_PATH = "/v1/integrate";
const Id = z.uuid();
const Sha = z.string().regex(/^[a-f0-9]{40,64}$/u);
const Commit = z.string().regex(/^[a-f0-9]{7,64}$/u);
const Text = z.string().trim().min(1).max(512);
export const HoldOverrideSchema = z.object({ holdId: Id, actor: Text, reason: Text }).strict();
export type HoldOverride = z.infer<typeof HoldOverrideSchema>;
const Overrides = z.array(HoldOverrideSchema).max(32).default([]);

export const IntegrationRunSchema = z
  .object({
    action: z.literal("run"),
    id: Id,
    core: z.array(Commit).max(100).default([]),
    app: z.array(Commit).max(100).optional(),
    restore: Id.optional(),
    push: z.boolean().default(false),
    overrides: Overrides,
  })
  .strict()
  .refine(
    (r) =>
      r.restore ? r.core.length === 0 && r.app === undefined : r.core.length + (r.app?.length ?? 0) > 0,
    "Supply approved commits, or a passed batch to restore",
  );
export type IntegrationRun = z.infer<typeof IntegrationRunSchema>;
export const IntegrationRequestSchema = z.union([
  IntegrationRunSchema,
  z.object({ action: z.literal("status"), id: Id }).strict(),
  z.object({ action: z.literal("push"), id: Id, overrides: Overrides }).strict(),
  z.object({ action: z.literal("holds") }).strict(),
  z
    .object({
      action: z.literal("hold"),
      id: Id,
      holder: Text,
      reason: Text,
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
  pane: Text.optional(),
  seat: Text.optional(),
  presence: z.enum(["present", "gone", "unknown", "person"]),
});
export type DeployHold = z.infer<typeof DeployHoldSchema>;
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
  origin: z.string(),
  base: Sha,
  directory: z.string(),
  head: Sha,
  commits: z.array(
    z.object({
      commit: Commit,
      state: z.enum(["pending", "applied", "already_present", "conflict", "blocked", "failed"]),
      head: Sha.optional(),
      conflicts: z.array(z.string()).optional(),
      error: z.string().optional(),
    }),
  ),
  install: CommandRecordSchema.optional(),
  gate: CommandRecordSchema.optional(),
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
  request: IntegrationRunSchema,
  state: z.enum([
    "queued",
    "composing",
    "conflict",
    "installing",
    "gating",
    "failed",
    "passed",
    "held",
    "pushing",
    "pushed",
    "partial",
    "interrupted",
  ]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  evidence: z.string(),
  repos: z.array(IntegrationRepoSchema),
  error: z.string().optional(),
});
export type IntegrationBatch = z.infer<typeof IntegrationBatchSchema>;
export const IntegrationResponseSchema = z.object({
  ok: z.boolean(),
  batch: IntegrationBatchSchema.optional(),
  holds: z.array(DeployHoldSchema).optional(),
  error: z.string().optional(),
});
export type IntegrationResponse = z.infer<typeof IntegrationResponseSchema>;
