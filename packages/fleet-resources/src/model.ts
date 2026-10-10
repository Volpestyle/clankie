import type { SimulatorUsage } from "./simulator-usage.ts";
import { z } from "zod";

export const FleetResourcePolicySchema = z
  .object({
    heavySlots: z.number().int().min(1).max(64).nullable().default(null),
    simulatorSlots: z.number().int().min(0).max(64).default(1),
    simulatorIdleMs: z.number().int().min(1_000).max(86_400_000).default(600_000),
    maxLoadRatio: z.number().positive().max(16).default(1.5),
    minAvailableMemoryMb: z.number().int().min(0).max(1_048_576).default(4096),
  })
  .strict();
export type FleetResourcePolicy = z.infer<typeof FleetResourcePolicySchema>;
export const defaultResourcePolicy = (): FleetResourcePolicy => FleetResourcePolicySchema.parse({});
export interface ResourcePressureInput {
  loadRatio: number;
  availableMemoryMb: number;
}
export interface ResourcePressure extends ResourcePressureInput {
  sampledAtMs: number;
  healthy: boolean;
  reason?: "load" | "memory" | "probe-unavailable";
}
export interface ProcessIdentity {
  pid: number;
  startTime: string;
  pgid: number;
  ppid: number;
  uid: number;
  legacyStartTime?: string;
}
export interface ProcessProof {
  pid: number;
  startTime: string;
}
export interface SimulatorReservation {
  id: string;
  token: string;
  kind: "simulator";
  seatId: string;
  holderId?: string;
  occupantId: string;
  fleet?: string;
  pane?: string;
  binding?: { socketPath: string; session?: string };
  ownerProcesses?: ProcessProof[];
  createdAtMs: number;
  lastUsedAtMs: number;
  phase: string;
  deviceId?: string;
  deviceName?: string;
  deviceType?: string;
  runtime?: string;
}
export type SimulatorUpdate = Partial<
  Pick<SimulatorReservation, "phase" | "deviceId" | "deviceName" | "deviceType" | "runtime" | "lastUsedAtMs">
>;
export interface HeavyLease {
  id: string;
  token: string;
  kind: "heavy";
  state: "starting" | "running";
  seatId?: string;
  holderId?: string;
  executable: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  claimOwner: ProcessIdentity;
  runner?: ProcessIdentity;
  descendants?: ProcessProof[];
}
interface SimulatorTicketSelection {
  occupantId: string;
  fleet?: string;
  deviceId?: string;
  deviceType?: string;
  runtime?: string;
  exact: boolean;
  targetDeviceId?: string;
  expiresAtMs: number;
}
export interface ResourceQueueEntry {
  id: string;
  token: string;
  kind: "heavy" | "simulator";
  seatId?: string;
  holderId?: string;
  executable?: string;
  queuedAtMs: number;
  owner: ProcessIdentity;
  simulator?: SimulatorTicketSelection;
}
export interface ResourceState {
  schemaVersion: 1;
  policy: FleetResourcePolicy;
  leases: (HeavyLease | SimulatorReservation)[];
  queue: ResourceQueueEntry[];
}
const SafeText = z
  .string()
  .max(512)
  .refine((value) => !value.includes("\0"));
const Timestamp = z.number().int().nonnegative();
const ProofSchema = z
  .object({ pid: z.number().int().min(2), startTime: z.string().min(1).max(128) })
  .strict();
const IdentitySchema = ProofSchema.extend({
  pgid: z.number().int().min(1),
  ppid: z.number().int().nonnegative(),
  uid: z.number().int().nonnegative(),
  legacyStartTime: z.string().max(128).optional(),
});
const Common = {
  id: z.string().uuid(),
  token: z.string().uuid(),
  createdAtMs: Timestamp,
  lastUsedAtMs: Timestamp,
};
export const ResourceStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    policy: FleetResourcePolicySchema,
    leases: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              ...Common,
              kind: z.literal("heavy"),
              state: z.enum(["starting", "running"]),
              seatId: SafeText.optional(),
              holderId: SafeText.optional(),
              executable: SafeText,
              claimOwner: IdentitySchema,
              runner: IdentitySchema.optional(),
              descendants: z.array(ProofSchema).max(128).optional(),
            })
            .strict(),
          z
            .object({
              ...Common,
              kind: z.literal("simulator"),
              seatId: SafeText,
              holderId: SafeText.optional(),
              occupantId: SafeText,
              fleet: SafeText.optional(),
              pane: SafeText.optional(),
              binding: z
                .object({ socketPath: z.string().max(4096), session: SafeText.optional() })
                .strict()
                .optional(),
              ownerProcesses: z.array(ProofSchema).max(32).optional(),
              phase: SafeText,
              deviceId: SafeText.optional(),
              deviceName: SafeText.optional(),
              deviceType: SafeText.optional(),
              runtime: SafeText.optional(),
            })
            .strict(),
        ]),
      )
      .max(128),
    queue: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            token: z.string().uuid(),
            kind: z.enum(["heavy", "simulator"]),
            seatId: SafeText.optional(),
            holderId: SafeText.optional(),
            executable: SafeText.optional(),
            queuedAtMs: Timestamp,
            owner: IdentitySchema,
            simulator: z
              .object({
                occupantId: SafeText,
                fleet: SafeText.optional(),
                deviceId: SafeText.optional(),
                deviceType: SafeText.optional(),
                runtime: SafeText.optional(),
                exact: z.boolean(),
                targetDeviceId: SafeText.optional(),
                expiresAtMs: Timestamp,
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(512),
  })
  .strict()
  .refine(
    (state) =>
      state.queue.every((entry) =>
        entry.kind === "heavy"
          ? entry.simulator === undefined
          : Boolean(entry.simulator && entry.seatId && entry.holderId),
      ),
    "Simulator tickets require their selection and native holder",
  );
export interface ResourceSnapshot {
  schemaVersion: 1;
  policy: FleetResourcePolicy;
  capacity: {
    heavySlots: number;
    simulatorSlots: number;
    used: number;
    simulatorUsed: number;
    /** Focused checks run in their own capped lane beside full gates (VUH-2023). */
    lightSlots: number;
    lightUsed: number;
  };
  pressure: ResourcePressure;
  leases: {
    id: string;
    kind: "heavy" | "simulator";
    state: string;
    seatId?: string;
    holderId?: string;
    executable?: string;
    createdAtMs: number;
    lastUsedAtMs: number;
    deviceId?: string;
    usage?: SimulatorUsage;
    pid?: number;
  }[];
  queue: {
    id: string;
    kind: "heavy" | "simulator";
    seatId?: string;
    holderId?: string;
    executable?: string;
    queuedAtMs: number;
    pid?: number;
    deviceId?: string;
    deviceType?: string;
    runtime?: string;
    exact?: boolean;
    expiresAtMs?: number;
    position?: number;
    estimatedWaitMs?: number | null;
  }[];
  lightLeases: {
    id: string;
    state: string;
    seatId?: string;
    holderId?: string;
    executable: string;
    createdAtMs: number;
    pid?: number;
  }[];
  lightQueue: {
    id: string;
    seatId?: string;
    holderId?: string;
    executable?: string;
    queuedAtMs: number;
    pid: number;
  }[];
}
export interface ResourceWaitOptions {
  signal?: AbortSignal;
  onWait?: (snapshot: ResourceSnapshot) => void;
}
export interface SimulatorAcquireOptions {
  seatId: string;
  holderId?: string;
  occupantId: string;
  fleet?: string;
  pane?: string;
  binding?: { socketPath: string; session?: string };
  ownerProcesses?: ProcessProof[];
  /** Read inside the registry lock, so admission and the count agree. */
  externalActive: () => Promise<number>;
  ticketId?: string;
  deviceId?: string;
  deviceType?: string;
  runtime?: string;
}
export type SimulatorAdmission =
  | { admitted: true; lease: SimulatorReservation }
  | {
      admitted: false;
      reason: "simulator_capacity" | "shared_capacity" | "pressure";
      snapshot: ResourceSnapshot;
    };
export interface FleetResourceGovernor {
  configure(policy: FleetResourcePolicy): Promise<ResourceSnapshot>;
  snapshot(): Promise<ResourceSnapshot>;
  /** Hire admission: refuses only on low available memory or an unverifiable probe. */
  admitBuilder(): Promise<{
    allowed: boolean;
    reason?: "pressure" | "probe-unavailable";
    pressure: ResourcePressure;
    /** The memory floor a `pressure` refusal fell below. */
    minAvailableMemoryMb?: number;
    /** Load is above the heavy-permit limit, so the seat's heavy work will queue. */
    heavyQueued?: { maxLoadRatio: number };
  }>;
  runHeavy(
    command: string,
    args: readonly string[],
    options?: ResourceWaitOptions & { seatId?: string; holderId?: string },
  ): Promise<number>;
  queueSimulator(
    options: Omit<SimulatorAcquireOptions, "externalActive"> & {
      selection: Omit<SimulatorTicketSelection, "occupantId" | "fleet" | "expiresAtMs">;
    },
  ): Promise<ResourceQueueEntry>;
  cancelSimulatorTicket(
    id: string,
    owner: Pick<SimulatorAcquireOptions, "seatId" | "holderId" | "occupantId" | "fleet">,
  ): Promise<boolean>;
  /** Atomically claim a ticket only at the front of its device's queue. */
  tryAcquireSimulator(options: SimulatorAcquireOptions): Promise<SimulatorAdmission>;
  simulatorReservations(): Promise<SimulatorReservation[]>;
  updateSimulator(id: string, token: string, update: SimulatorUpdate): Promise<SimulatorReservation>;
  releaseSimulator(id: string, token: string): Promise<void>;
  close(): Promise<void>;
}
