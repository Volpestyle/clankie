import { z } from "zod";

export const FLEET_RESOURCES_PATH = "/v1/operator/fleet-resources";
export const FLEET_SIMULATORS_PATH = `${FLEET_RESOURCES_PATH}/simulators`;

/** Owner policy; the command wrapper reads the shared policy, never worker overrides. */
export const FleetResourcePolicySchema = z
  .object({
    heavySlots: z.number().int().min(1).max(64).nullable().default(null),
    simulatorSlots: z.number().int().min(0).max(64).nullable().default(null),
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
/** Host-observed simulator runtime charge; unavailable never means zero. */
const FleetSimulatorUsageSchema = z.strictObject({
  sampledAtMs: timestamp,
  status: z.enum(["available", "partial", "unavailable"]),
  processCount: z.number().int().nonnegative().optional(),
  unavailableProcesses: z.number().int().nonnegative().optional(),
  rssBytes: z.number().int().nonnegative().optional(),
  footprintBytes: z.number().int().nonnegative().optional(),
  cpuTimeMs: z.number().finite().nonnegative().optional(),
  cpuPercent: z.number().finite().nonnegative().optional(),
  intervalMs: z.number().finite().positive().optional(),
});
export const FleetResourceSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    policy: FleetResourcePolicySchema,
    capacity: z
      .object({
        heavySlots: z.number().int().min(1).max(64),
        simulatorSlots: z.number().int().min(0).max(64),
        /** Heavy leases only on current servers. */
        used: z.number().int().nonnegative(),
        /** Optional for compatibility with older servers. */
        simulatorUsed: z.number().int().nonnegative().optional(),
        /** The light lane for focused checks (VUH-2023); absent from older servers. */
        lightSlots: z.number().int().min(1).max(64).optional(),
        lightUsed: z.number().int().nonnegative().optional(),
      })
      .strict(),
    pressure: z
      .object({
        sampledAtMs: timestamp,
        loadRatio: z.number().finite().nonnegative(),
        cpuRatio: z.number().finite().min(0).max(1).optional(),
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
            holderId: reference.optional(),
            pid: z.number().int().min(2).max(2_147_483_647).optional(),
            executable: z.string().min(1).max(256).optional(),
            createdAtMs: timestamp,
            lastUsedAtMs: timestamp,
            deviceId: reference.optional(),
            usage: FleetSimulatorUsageSchema.optional(),
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
            holderId: reference.optional(),
            pid: z.number().int().min(2).max(2_147_483_647).optional(),
            executable: z.string().min(1).max(256).optional(),
            queuedAtMs: timestamp,
            deviceId: reference.optional(),
            deviceType: reference.optional(),
            runtime: reference.optional(),
            exact: z.boolean().optional(),
            expiresAtMs: timestamp.optional(),
            position: z.number().int().positive().optional(),
            estimatedWaitMs: timestamp.nullable().optional(),
          })
          .strict(),
      )
      .max(512),
    /** Focused checks holding or waiting for the light lane; absent from older servers. */
    lightLeases: z
      .array(
        z
          .object({
            id: reference,
            state: z.string().min(1).max(64),
            seatId: reference.optional(),
            holderId: reference.optional(),
            pid: z.number().int().min(2).max(2_147_483_647).optional(),
            executable: z.string().min(1).max(256),
            createdAtMs: timestamp,
          })
          .strict(),
      )
      .max(128)
      .optional(),
    lightQueue: z
      .array(
        z
          .object({
            id: reference,
            seatId: reference.optional(),
            holderId: reference.optional(),
            pid: z.number().int().min(2).max(2_147_483_647).optional(),
            executable: z.string().min(1).max(256).optional(),
            queuedAtMs: timestamp,
          })
          .strict(),
      )
      .max(512)
      .optional(),
  })
  .strict();
export type FleetResourceSnapshot = z.infer<typeof FleetResourceSnapshotSchema>;

const SimulatorSeatSchema = z
  .object({ seatId: reference, holderId: reference.optional(), fleet: reference.optional() })
  .strict();
const udid = z.string().regex(/^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/u);
/** Native occupant and process identities are observed by the host, never supplied here. */
const SimulatorSelectionSchema = SimulatorSeatSchema.extend({
  /** Both are required unless `deviceId` names the device. */
  deviceType: reference.optional(),
  runtime: reference.optional(),
  /** Lease this existing device (for example one the seat booted by hand) instead of choosing one. */
  deviceId: udid.optional(),
  /** Refuse instead of substituting a close model when no exact device exists or can be created. */
  exact: z.boolean().optional(),
}).strict();
export const FleetSimulatorRequestSchema = z.discriminatedUnion("action", [
  SimulatorSelectionSchema.extend({ action: z.literal("plan") }).strict(),
  SimulatorSelectionSchema.extend({
    action: z.literal("acquire"),
    waitMs: z.number().int().min(0).max(3_600_000).optional(),
    ticketId: reference.optional(),
  }).strict(),
  SimulatorSeatSchema.extend({ action: z.literal("cancel"), id: reference }).strict(),
  SimulatorSeatSchema.extend({ action: z.literal("verify"), id: reference, deviceId: udid }).strict(),
  SimulatorSeatSchema.extend({ action: z.literal("touch"), id: reference }).strict(),
  SimulatorSeatSchema.extend({ action: z.literal("release"), id: reference }).strict(),
]);
export type FleetSimulatorRequest = z.infer<typeof FleetSimulatorRequestSchema>;

export const FleetSimulatorLeaseSchema = z
  .object({
    id: reference,
    seatId: reference,
    holderId: reference.optional(),
    occupantId: reference,
    fleet: reference.optional(),
    phase: z.string().min(1).max(64),
    createdAtMs: timestamp,
    lastUsedAtMs: timestamp,
    deviceId: reference.optional(),
    deviceName: z.string().min(1).max(256).optional(),
    deviceType: z.string().min(1).max(256).optional(),
    runtime: z.string().min(1).max(256).optional(),
    /** Informational device origin; release stops and retains every device. */
    usage: FleetSimulatorUsageSchema.optional(),
    origin: z.enum(["created", "existing"]).optional(),
    /** Present when a close model stood in for the requested device type. */
    requestedDeviceType: z.string().min(1).max(256).optional(),
  })
  .strict();
/** A live process that names the device, mapped to the seat whose pane it runs in when provable. */
const FleetSimulatorHolderSchema = z
  .object({
    pid: z.number().int().min(2).max(2_147_483_647),
    executable: z.string().min(1).max(256),
    seatId: reference.optional(),
    pane: reference.optional(),
  })
  .strict();
/** A booted or booting device that no lease owns; it still counts against the simulator limit. */
const FleetExternalSimulatorSchema = z
  .object({
    udid: reference,
    name: z.string().min(1).max(256),
    state: z.string().min(1).max(64),
    runtime: z.string().min(1).max(256),
    deviceType: z.string().min(1).max(256).optional(),
    holders: z.array(FleetSimulatorHolderSchema).max(32),
    usage: FleetSimulatorUsageSchema.optional(),
  })
  .strict();
export const FleetSimulatorStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    leases: z.array(FleetSimulatorLeaseSchema).max(256),
    inventory: z.enum(["available", "unavailable"]),
    externalActive: z.number().int().nonnegative().nullable(),
    external: z.array(FleetExternalSimulatorSchema).max(256).optional(),
    simulatorSlots: z.number().int().min(0).max(64).optional(),
    hint: z.string().min(1).max(1024).optional(),
  })
  .strict();
/** What keeps an acquire from being admitted right now. */
const FleetSimulatorBlockersSchema = z
  .object({
    simulatorSlots: z.number().int().min(0).max(64),
    heavySlots: z.number().int().min(1).max(64).optional(),
    sharedSlots: z.number().int().min(1).max(64).optional(),
    leases: z
      .array(
        z
          .object({
            id: reference,
            seatId: reference,
            holderId: reference.optional(),
            phase: z.string().min(1).max(64),
            deviceName: z.string().min(1).max(256).optional(),
            deviceId: reference.optional(),
          })
          .strict(),
      )
      .max(256),
    external: z.array(FleetExternalSimulatorSchema).max(256),
    heavy: z
      .array(
        z
          .object({
            seatId: reference.optional(),
            holderId: reference.optional(),
            executable: z.string().min(1).max(256).optional(),
            pid: z.number().int().min(2).max(2_147_483_647).optional(),
          })
          .strict(),
      )
      .max(256),
    pressure: z
      .object({
        reason: z.enum(["load", "memory", "probe-unavailable"]).optional(),
        loadRatio: z.number().finite().nonnegative(),
        availableMemoryMb: z.number().finite().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();
const FLEET_SIMULATOR_REJECTIONS = [
  /** The seat's live native occupant or process ownership could not be proven. */
  "owner_unavailable",
  "stale_owner",
  "inventory_unavailable",
  "capacity",
  "lease_unavailable",
  /** The service is starting or stopping; retry after it is back. */
  "service_restarting",
  /** Owner authority ended while the request was in flight. */
  "authorization_revoked",
  /** The owner's simulator limit is zero. */
  "simulators_disabled",
  /** The requested type, runtime or device cannot be used; `alternatives` lists close existing ones. */
  "device_unavailable",
  /** The seat is not a proven local native seat. */
  "seat_not_local",
  /** An unexpected service failure; the service log has the cause. */
  "internal_error",
  "ticket_unavailable",
] as const;
export const FleetSimulatorResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("planned"),
      choice: z.enum(["reuse", "create"]),
      simulatorIdleMs: z.number().int().min(1000).max(86_400_000),
    })
    .strict(),
  z
    .object({
      outcome: z.enum(["acquired", "held", "booting"]),
      lease: FleetSimulatorLeaseSchema,
      /** For `booting`: poll acquire again (it is idempotent per seat) after this delay. */
      retryAfterMs: z.number().int().min(0).max(600_000).optional(),
    })
    .strict(),
  z.object({ outcome: z.enum(["released", "cancelled"]) }).strict(),
  z
    .object({
      outcome: z.literal("waiting"),
      ticket: FleetResourceSnapshotSchema.shape.queue.element.optional(),
      reason: z.enum(["simulator_capacity", "shared_capacity", "pressure"]),
      blockers: FleetSimulatorBlockersSchema,
      retryAfterMs: z.number().int().min(0).max(600_000),
      hint: z.string().min(1).max(1024),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("rejected"),
      reason: z.enum(FLEET_SIMULATOR_REJECTIONS),
      detail: z.string().min(1).max(1024).optional(),
      alternatives: z
        .array(
          z
            .object({ deviceType: reference, name: z.string().min(1).max(256), udid: reference.optional() })
            .strict(),
        )
        .max(32)
        .optional(),
    })
    .strict(),
]);
export type FleetSimulatorStatus = z.infer<typeof FleetSimulatorStatusSchema>;
