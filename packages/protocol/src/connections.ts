import { z } from "zod";
import { MachineAccessLevelSchema } from "./machine-access.ts";

const connectionId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const label = z.string().max(4096);
export const RUNTIME_CAPACITY_DEFAULT = 16;
export const RUNTIME_CAPACITY_MAX = 256;

export const MachineSessionSchema = z
  .object({
    name: label,
    socketPath: label.optional(),
    connectionId: connectionId.optional(),
    state: z.enum(["available", "connected", "disabled", "unreachable"]),
    workerCount: z.number().int().nonnegative().nullable(),
  })
  .strict();
export const MachineSchema = z
  .object({
    id: connectionId,
    transport: z.enum(["local", "ssh"]),
    accessLevel: MachineAccessLevelSchema.optional(),
    accessEnforcement: z.literal("service-preference").optional(),
    ssh: label.optional(),
    shell: z.enum(["posix", "powershell"]).optional(),
    configured: z.boolean(),
    state: z.enum(["available", "unreachable", "discovering"]),
    workerCount: z.number().int().nonnegative().nullable(),
    sessions: z.array(MachineSessionSchema).max(64),
  })
  .strict();
export const MachineInventorySchema = z
  .object({
    observedAt: z.string(),
    machines: z.array(MachineSchema).max(64),
  })
  .strict();
export type MachineInventory = z.infer<typeof MachineInventorySchema>;
export type Machine = z.infer<typeof MachineSchema>;

/** Connection changes share the operator relay's steer authority. No credentials cross it. */
export const OperatorConnectionCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("discover") }).strict(),
  z
    .object({
      action: z.literal("add_machine"),
      id: connectionId,
      ssh: z.string().regex(/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/u),
      shell: z.enum(["posix", "powershell"]).default("posix"),
    })
    .strict(),
  z.object({ action: z.literal("remove_machine"), id: connectionId }).strict(),
  z
    .object({
      action: z.literal("set_machine_access"),
      id: connectionId,
      accessLevel: MachineAccessLevelSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("connect_runtime"),
      id: connectionId,
      machine: connectionId.optional(),
      session: z.string().regex(/^[\w][\w.-]{0,63}$/u),
    })
    .strict(),
  z.object({ action: z.literal("reconnect_runtime"), id: connectionId }).strict(),
  z.object({ action: z.literal("disconnect_runtime"), id: connectionId }).strict(),
  /** How many workers one runtime (a Herdr session) may hold at once; the host default is 16. */
  z
    .object({
      action: z.literal("set_runtime_capacity"),
      id: connectionId,
      capacity: z.number().int().min(1).max(RUNTIME_CAPACITY_MAX),
    })
    .strict(),
]);
export type OperatorConnectionCommand = z.infer<typeof OperatorConnectionCommandSchema>;

export const OperatorConnectionInventorySchema = z
  .object({
    observedAt: z.string(),
    machines: z.array(MachineSchema).max(64).default([]),
    runtimes: z
      .array(
        z
          .object({
            id: connectionId,
            machine: connectionId.default("local"),
            kind: z.literal("herdr"),
            session: label,
            state: label,
            enabled: z.boolean(),
            capacity: z.number().int().nonnegative().nullable(),
            capabilities: z.array(label).max(64),
          })
          .strict(),
      )
      .max(16),
    linear: z
      .object({
        status: z.enum(["verified", "unverified", "disconnected", "unavailable"]),
        email: label.optional(),
        workspace: label.optional(),
        verifiedAt: label.optional(),
      })
      .strict(),
  })
  .strict();
export type OperatorConnectionInventory = z.infer<typeof OperatorConnectionInventorySchema>;

export const OperatorConnectionResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ready"), inventory: OperatorConnectionInventorySchema }).strict(),
  z.object({ outcome: z.literal("refused"), message: z.string().max(1024) }).strict(),
]);
