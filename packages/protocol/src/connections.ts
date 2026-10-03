import { z } from "zod";

const connectionId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const label = z.string().max(4096);
export const RUNTIME_CAPACITY_DEFAULT = 16;
export const RUNTIME_CAPACITY_MAX = 256;

/** Connection changes share the operator relay's steer authority. No credentials cross it. */
export const OperatorConnectionCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z
    .object({
      action: z.literal("connect_runtime"),
      id: connectionId,
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
    runtimes: z
      .array(
        z
          .object({
            id: connectionId,
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
