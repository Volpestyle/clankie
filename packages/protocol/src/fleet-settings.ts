import { z } from "zod";
import {
  FleetAutonomyWireSchema,
  FleetAutonomyPatchSchema,
  FleetWorkingPreferencesSchema,
  FleetGatesSchema,
} from "./autonomy.ts";
import { ProjectIdSchema } from "./projects.ts";
import { FleetResourcePolicySchema } from "./fleet-resources.ts";

export const FLEET_SETTINGS_PATH = "/v1/operator/fleet-settings";
export const FLEET_SETTINGS_CONTEXT_PATH = `${FLEET_SETTINGS_PATH}/context`;
const FleetPolicySchema = z
  .object({
    size: z.enum(["max", "large", "small", "solo"]),
    models: z.enum(["optimal", "efficient"]),
    resources: FleetResourcePolicySchema.optional(),
    ...FleetAutonomyWireSchema.shape,
  })
  .strict();
export const FleetSettingsSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.string().regex(/^[a-f0-9]{64}$/u),
    fleet: FleetPolicySchema,
    /** Advertises support explicitly; absence identifies an older service. */
    workingPreferences: z.literal(true).optional(),
    fleetGates: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (value) => value.fleetGates !== true || FleetGatesSchema.strip().safeParse(value.fleet).success,
    "A fleet-gates snapshot must include every global gate",
  )
  .refine(
    (value) =>
      value.workingPreferences !== true ||
      FleetWorkingPreferencesSchema.safeParse({
        commit: value.fleet.commit,
        push: value.fleet.push,
        release: value.fleet.release,
        verification: value.fleet.verification,
        reportingStyle: value.fleet.reportingStyle,
      }).success,
    "A working-preferences snapshot must include every global preference",
  );
export type FleetSettingsSnapshot = z.infer<typeof FleetSettingsSnapshotSchema>;
export const UpdateFleetSettingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    changes: FleetPolicySchema.partial()
      .extend(FleetAutonomyPatchSchema.shape)
      .refine(
        (value) => Object.values(value).some((field) => field !== undefined),
        "No fleet settings changes supplied",
      ),
  })
  .strict();
export type UpdateFleetSettings = z.infer<typeof UpdateFleetSettingsSchema>;

const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !/\p{Cc}/u.test(value) &&
      (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/u.test(value)),
    "An absolute directory or script path is required",
  );
const MachineRefSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
export const FleetSettingsContextRequestSchema = z
  .object({
    workingDirectory: AbsolutePathSchema,
    machine: MachineRefSchema,
    projectId: ProjectIdSchema.optional(),
  })
  .strict();
export type FleetSettingsContextRequest = z.infer<typeof FleetSettingsContextRequestSchema>;
export const FleetSettingsContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    effective: FleetAutonomyWireSchema,
    workingPreferences: z.literal(true).optional(),
    fleetGates: z.literal(true).optional(),
    projectId: ProjectIdSchema.optional(),
    machine: z
      .object({
        id: MachineRefSchema,
        linked: z.boolean(),
        /** Nonsecret revision of the resolved registered target, including its transport and session. */
        targetRevision: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
  })
  .strict()
  .refine(
    (value) => value.fleetGates !== true || FleetGatesSchema.strip().safeParse(value.effective).success,
    "A fleet-gates context must include every effective gate",
  )
  .refine(
    (value) =>
      value.workingPreferences !== true ||
      FleetWorkingPreferencesSchema.safeParse({
        commit: value.effective.commit,
        push: value.effective.push,
        release: value.effective.release,
        verification: value.effective.verification,
        reportingStyle: value.effective.reportingStyle,
      }).success,
    "A working-preferences context must include every effective preference",
  );
export type FleetSettingsContext = z.infer<typeof FleetSettingsContextSchema>;

/** The operator's source workspace determines policy; this does not select another project. */
export const FleetPrepareRequestSchema = z
  .object({
    workingDirectory: AbsolutePathSchema,
    projectId: ProjectIdSchema.optional(),
    /** Caller-reported owner consent, still subject to current operator authority and policy fences. */
    ownerApproved: z.boolean().default(false),
    /** Pins the target shown during caller consent; omission claims the current alias target. */
    expectedMachineRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    /** A newly supplied source script always requires claimed owner consent. */
    codexSourceSetup: AbsolutePathSchema.optional(),
  })
  .strict();
export type FleetPrepareRequest = z.infer<typeof FleetPrepareRequestSchema>;

/** Refresh only existing links; source-manager approvals remain their own recorded proof. */
export const FleetHarnessRefreshRequestSchema = FleetPrepareRequestSchema.omit({
  codexSourceSetup: true,
  expectedMachineRevision: true,
});
export type FleetHarnessRefreshRequest = z.infer<typeof FleetHarnessRefreshRequestSchema>;
