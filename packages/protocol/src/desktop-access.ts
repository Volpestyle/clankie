import { z } from "zod";
import { MachineAccessLevelSchema, machineAccessAllows } from "./machine-access.ts";

/** ADR 0342. A preference never grants a machine ceiling or an OS permission. */
export const DesktopModeSchema = z.enum(["none", "host", "screen", "vm"]);
export type DesktopMode = z.infer<typeof DesktopModeSchema>;
export const DesktopMachineIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
export const DesktopLeadIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u);
export const DesktopChoiceSchema = z.strictObject({
  desktopMode: DesktopModeSchema.default("none"),
  leadModes: z.record(DesktopLeadIdSchema, DesktopModeSchema).default({}),
});
export const ComputerSettingsSchema = z.strictObject({
  machines: z.record(DesktopMachineIdSchema, DesktopChoiceSchema).default({}),
});

/** Preflight cannot distinguish a denied grant from one never requested. */
export const DesktopPermissionStateSchema = z.enum(["granted", "not_granted", "unknown"]);
export const DesktopActorPermissionsSchema = z.strictObject({
  actor: z.strictObject({
    bundleId: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    pid: z.number().int().positive(),
  }),
  observedAt: z.string().datetime(),
  accessibility: DesktopPermissionStateSchema,
  screenRecording: DesktopPermissionStateSchema,
});
export type DesktopActorPermissions = z.infer<typeof DesktopActorPermissionsSchema>;
export const DesktopPermissionsSnapshotSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("observed"), observation: DesktopActorPermissionsSchema }),
  z.strictObject({
    state: z.literal("unavailable"),
    reason: z.enum(["not_checked", "stale", "unsupported"]),
  }),
]);
export type DesktopPermissionsSnapshot = z.infer<typeof DesktopPermissionsSnapshotSchema>;

export function desktopModeAllowed(mode: DesktopMode, ceiling: unknown): boolean {
  return mode === "none" || machineAccessAllows(ceiling, mode === "vm" ? "workers" : "screen");
}

export const DesktopAccessSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  machineId: DesktopMachineIdSchema,
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
  desktopMode: DesktopModeSchema,
  leadModes: z.record(DesktopLeadIdSchema, DesktopModeSchema),
  selectedLead: DesktopLeadIdSchema.optional(),
  selectedMode: DesktopModeSchema,
  /** Ceiling-bounded preference, not runtime/VM readiness or authorization. */
  effectiveMode: DesktopModeSchema,
  accessLevel: MachineAccessLevelSchema,
  permissions: DesktopPermissionsSnapshotSchema,
  /** This API configures preferences; it does not provision or launch desktops. */
  vm: z.strictObject({ state: z.literal("unavailable") }),
});
export type DesktopAccessSnapshot = z.infer<typeof DesktopAccessSnapshotSchema>;
export const UpdateDesktopModeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  expectedRevision: DesktopAccessSnapshotSchema.shape.revision,
  machineId: DesktopMachineIdSchema.default("local"),
  mode: DesktopModeSchema,
  lead: DesktopLeadIdSchema.optional(),
});
export const PublishDesktopPermissionsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  observation: DesktopActorPermissionsSchema,
});
export const DESKTOP_ACCESS_PATH = "/v1/operator/computer";

/** Closed query grammar shared by encrypted doorway, relay and service. */
export function isDesktopAccessRoute(path: string): boolean {
  const [base, query] = path.split("?");
  if (base !== DESKTOP_ACCESS_PATH || path.split("?").length > 2) return false;
  const params = new URLSearchParams(query);
  if ([...params.keys()].some((key) => !["machine", "lead"].includes(key) || params.getAll(key).length !== 1))
    return false;
  return (
    (params.get("machine") === null || DesktopMachineIdSchema.safeParse(params.get("machine")).success) &&
    (params.get("lead") === null || DesktopLeadIdSchema.safeParse(params.get("lead")).success)
  );
}

/** A fresh check has its own response; old strict snapshot clients are unchanged. */
export const REFRESH_DESKTOP_PERMISSIONS_PATH = `${DESKTOP_ACCESS_PATH}/permissions/refresh`;
export const RefreshDesktopPermissionsSchema = z.strictObject({ schemaVersion: z.literal(1) });
export const DesktopPermissionCheckSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("observed"), observation: DesktopActorPermissionsSchema }),
  z.strictObject({
    state: z.literal("unavailable"),
    reason: z.enum([
      "unsupported",
      "terminal_unavailable",
      "terminal_context_unavailable",
      "terminal_changed",
      "check_in_progress",
      "timed_out",
      "invalid_observation",
      "launch_unconfirmed",
    ]),
  }),
]);
export type DesktopPermissionCheck = z.infer<typeof DesktopPermissionCheckSchema>;
