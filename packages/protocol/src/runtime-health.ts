import { z } from "zod";

export const RUNTIME_HEALTH_PATH = "/v1/operator/runtime-health";
export const RuntimeHealthSettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    cpuPercent: z.number().min(1).max(1000).default(50),
    healthLatencyMs: z.number().int().min(1).max(60_000).default(1000),
    sustainedMs: z.number().int().min(100).max(86_400_000).default(300_000),
    sampleIntervalMs: z.number().int().min(100).max(60_000).default(15_000),
    cooldownMs: z.number().int().min(1000).max(86_400_000).default(1_800_000),
  })
  .strict();
export type RuntimeHealthSettings = z.infer<typeof RuntimeHealthSettingsSchema>;
// Defaults belong to complete settings reads, never to a partial update.
export const RuntimeHealthPatchSchema = z
  .object({
    enabled: RuntimeHealthSettingsSchema.shape.enabled.removeDefault(),
    cpuPercent: RuntimeHealthSettingsSchema.shape.cpuPercent.removeDefault(),
    healthLatencyMs: RuntimeHealthSettingsSchema.shape.healthLatencyMs.removeDefault(),
    sustainedMs: RuntimeHealthSettingsSchema.shape.sustainedMs.removeDefault(),
    sampleIntervalMs: RuntimeHealthSettingsSchema.shape.sampleIntervalMs.removeDefault(),
    cooldownMs: RuntimeHealthSettingsSchema.shape.cooldownMs.removeDefault(),
  })
  .partial()
  .strict();

/** Fixed process metadata only: safe for public health and consented hosted diagnostics. */
export const RuntimeHealthObservationSchema = z
  .object({
    state: z.enum(["starting", "disabled", "healthy", "sustaining", "alarm", "cooldown"]),
    observedAt: z.string().datetime().optional(),
    cpuPercent: z.number().min(0).max(10_000).optional(),
    healthLatencyMs: z.number().int().min(0).max(86_400_000).optional(),
    healthAvailable: z.boolean().optional(),
    durationMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    reasons: z.array(z.enum(["cpu", "health"])).max(2),
    /** Native seat delivery of the latest alarm or recovery notice. */
    delivery: z.enum(["none", "accepted", "unavailable"]),
    /**
     * Whether that notice is recorded in the owner's default conversation, which
     * never depends on the seat taking a delivery (VUH-1702). Absent before any notice.
     */
    recorded: z.boolean().optional(),
    lastAlarmAt: z.string().datetime().optional(),
    lastRecoveryAt: z.string().datetime().optional(),
    lastIncidentDurationMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();
export type RuntimeHealthObservation = z.infer<typeof RuntimeHealthObservationSchema>;
export const RuntimeHealthSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.string().regex(/^[a-f0-9]{64}$/u),
    settings: RuntimeHealthSettingsSchema,
    observation: RuntimeHealthObservationSchema,
  })
  .strict();
export type RuntimeHealthSnapshot = z.infer<typeof RuntimeHealthSnapshotSchema>;
export const UpdateRuntimeHealthSchema = z
  .object({
    schemaVersion: z.literal(1),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    changes: RuntimeHealthPatchSchema.refine((value) => Object.keys(value).length > 0),
  })
  .strict();
/** Process counters only. 100% CPU means one core; consumers difference one boot's samples. */
export const ProcessHealthSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  instanceId: z.uuid(),
  pid: z.number().int().safe().min(2),
  uptimeMs: z.number().finite().nonnegative(),
  cpu: z.strictObject({
    userMicros: z.number().int().safe().nonnegative(),
    systemMicros: z.number().int().safe().nonnegative(),
  }),
});
export type ProcessHealthSnapshot = z.infer<typeof ProcessHealthSnapshotSchema>;
