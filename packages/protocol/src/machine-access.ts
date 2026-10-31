import { z } from "zod";

/** Owner intent, independent of speaker authority and native workspace proof. */
export const MACHINE_ACCESS_LEVELS = ["portal", "workers", "shell", "screen"] as const;
export const MachineAccessLevelSchema = z.enum(MACHINE_ACCESS_LEVELS);
export type MachineAccessLevel = z.infer<typeof MachineAccessLevelSchema>;
export const MachineAccessChangeSchema = z.object({ accessLevel: MachineAccessLevelSchema }).strict();
export const MachineAccessSettingsSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u), MachineAccessLevelSchema)
  .default({});

/** No unknown value can be interpreted as full access. */
export function machineAccessAllows(level: unknown, required: MachineAccessLevel): boolean {
  const parsed = MachineAccessLevelSchema.safeParse(level);
  const operation = MachineAccessLevelSchema.safeParse(required);
  return (
    parsed.success &&
    operation.success &&
    MACHINE_ACCESS_LEVELS.indexOf(parsed.data) >= MACHINE_ACCESS_LEVELS.indexOf(operation.data)
  );
}

export class MachineAccessRefused extends Error {
  readonly code = "machine_access_refused";
  readonly machine: string;
  readonly accessLevel: MachineAccessLevel;
  readonly required: MachineAccessLevel;
  constructor(machine: string, accessLevel: MachineAccessLevel, required: MachineAccessLevel) {
    super(
      `Machine ${machine} has ${accessLevel} access; this request requires ${required}. An owner can change its level in Machines.`,
    );
    this.machine = machine;
    this.accessLevel = accessLevel;
    this.required = required;
  }
}

export const MachineAccessRefusalSchema = z
  .object({
    machine: z.string(),
    accessLevel: MachineAccessLevelSchema,
    required: MachineAccessLevelSchema,
    observedAt: z.string().datetime(),
    fix: z.string(),
  })
  .strict();
export type MachineAccessRefusal = z.infer<typeof MachineAccessRefusalSchema>;
