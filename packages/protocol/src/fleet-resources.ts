import { z } from "zod";

export const FLEET_RESOURCES_PATH = "/v1/operator/fleet-resources";
export const FLEET_SIMULATORS_PATH = `${FLEET_RESOURCES_PATH}/simulators`;

/** Owner policy; the command wrapper reads the shared policy, never worker overrides. */
export const FleetResourcePolicySchema = z
  .object({
    heavySlots: z.number().int().min(1).max(64).nullable().default(null),
    simulatorSlots: z.number().int().min(0).max(64).default(1),
    simulatorIdleMs: z.number().int().min(1000).max(86_400_000).default(600_000),
    maxLoadRatio: z.number().finite().positive().max(16).default(1.5),
    minAvailableMemoryMb: z.number().int().min(0).max(1_048_576).default(4096),
  })
  .strict();
export type FleetResourcePolicy = z.infer<typeof FleetResourcePolicySchema>;

const reference = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\p{Cc}]+$/u);
const timestamp = z.number().int().nonnegative();
export const FleetResourceSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    policy: FleetResourcePolicySchema,
    capacity: z
      .object({
        heavySlots: z.number().int().min(1).max(64),
        simulatorSlots: z.number().int().min(0).max(64),
        used: z.number().int().nonnegative(),
      })
      .strict(),
    pressure: z
      .object({
        sampledAtMs: timestamp,
        loadRatio: z.number().finite().nonnegative(),
        availableMemoryMb: z.number().finite().nonnegative(),
        healthy: z.boolean(),
        reason: z.enum(["load", "memory", "probe-unavailable"]).optional(),
      })
      .strict(),
    leases: z
      .array(
        z
          .object({
            id: reference,
            kind: z.enum(["heavy", "simulator"]),
            state: z.string().min(1).max(64),
            seatId: reference.optional(),
            pid: z.number().int().min(2).max(2_147_483_647).optional(),
            executable: z.string().min(1).max(256).optional(),
            createdAtMs: timestamp,
            lastUsedAtMs: timestamp,
            deviceId: reference.optional(),
          })
          .strict(),
      )
      .max(256),
    queue: z
      .array(
        z
          .object({
            id: reference,
            kind: z.enum(["heavy", "simulator"]),
            seatId: reference.optional(),
            pid: z.number().int().min(2).max(2_147_483_647).optional(),
            executable: z.string().min(1).max(256).optional(),
            queuedAtMs: timestamp,
          })
          .strict(),
      )
      .max(512),
  })
  .strict();
export type FleetResourceSnapshot = z.infer<typeof FleetResourceSnapshotSchema>;

const SimulatorSeatSchema = z.object({ seatId: reference, fleet: reference.optional() }).strict();
/** Native occupant and process identities are observed by the host, never supplied here. */
export const FleetSimulatorRequestSchema = z.discriminatedUnion("action", [
  SimulatorSeatSchema.extend({
    action: z.literal("acquire"),
    deviceType: reference,
    runtime: reference,
  }).strict(),
  SimulatorSeatSchema.extend({ action: z.literal("touch"), id: reference }).strict(),
  SimulatorSeatSchema.extend({ action: z.literal("release"), id: reference }).strict(),
]);
export type FleetSimulatorRequest = z.infer<typeof FleetSimulatorRequestSchema>;

export const FleetSimulatorLeaseSchema = z
  .object({
    id: reference,
    seatId: reference,
    occupantId: reference,
    fleet: reference.optional(),
    phase: z.string().min(1).max(64),
    createdAtMs: timestamp,
    lastUsedAtMs: timestamp,
    deviceId: reference.optional(),
    deviceName: z.string().min(1).max(256).optional(),
    deviceType: z.string().min(1).max(256).optional(),
    runtime: z.string().min(1).max(256).optional(),
  })
  .strict();
export const FleetSimulatorStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    leases: z.array(FleetSimulatorLeaseSchema).max(256),
    inventory: z.enum(["available", "unavailable"]),
    externalActive: z.number().int().nonnegative().nullable(),
  })
  .strict();
export const FleetSimulatorResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.enum(["acquired", "held"]), lease: FleetSimulatorLeaseSchema }).strict(),
  z.object({ outcome: z.literal("released") }).strict(),
  z
    .object({
      outcome: z.literal("rejected"),
      reason: z.enum([
        "owner_unavailable",
        "stale_owner",
        "inventory_unavailable",
        "capacity",
        "lease_unavailable",
      ]),
    })
    .strict(),
]);
