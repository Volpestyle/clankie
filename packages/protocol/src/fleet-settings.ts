import { z } from "zod";
import {
  FleetAutonomyWireSchema,
  FleetAutonomyPatchSchema,
  FleetWorkingPreferencesSchema,
  FleetGatesSchema,
  AutonomyLevelSchema,
  AutonomyLevelReadingSchema,
  AutonomyDriftSchema,
} from "./autonomy.ts";
import { ProjectIdSchema } from "./projects.ts";
import { FleetResourcePolicySchema, FleetResourceMachineIdSchema } from "./fleet-resources.ts";
import { HireProfileSchema, HIRE_NO_PREFERENCE } from "./hire-profile.ts";
import { OPERATOR_SEAT_HARNESSES } from "./seat-harnesses.ts";
import { RetiredWorkingPreferencesSchema } from "./project-work-policy.ts";

/**
 * How long a finished hire's pane may sit idle, its reports read and its work landed, before
 * Clankie closes it; "off" leaves pane and worktree tidying to the lead (VUH-2392).
 */
export const FLEET_AUTO_TIDY = ["off", "30m", "1h", "4h", "1d"] as const;
export type FleetAutoTidy = (typeof FLEET_AUTO_TIDY)[number];
export const FLEET_AUTO_TIDY_MS: Readonly<Record<Exclude<FleetAutoTidy, "off">, number>> = {
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};
export const FLEET_SETTINGS_PATH = "/v1/operator/fleet-settings";
export const FLEET_SETTINGS_CONTEXT_PATH = `${FLEET_SETTINGS_PATH}/context`;
const FleetPolicySchema = z
  .object({
    size: z.enum(["max", "large", "small", "solo"]),
    models: z.enum(["optimal", "efficient"]),
    resources: FleetResourcePolicySchema.optional(),
    machineResources: z.record(FleetResourceMachineIdSchema, FleetResourcePolicySchema).optional(),
    notes: z.string().max(4000).optional(),
    tools: z.enum(["connected", "off"]).optional(),
    peerMessages: z.enum(["on", "off"]).optional(),
    remoteGates: z.enum(["on", "off"]).optional(),
    workerSandbox: z.enum(["on", "off"]).optional(),
    leadRestarts: z.enum(["on", "off"]).optional(),
    autoTidy: z.enum(FLEET_AUTO_TIDY).optional(),
    hire: HireProfileSchema.optional(),
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
    workPolicy: z.literal(true).optional(),
    retiredWorkingPreferences: RetiredWorkingPreferencesSchema.optional(),
    fleetGates: z.literal(true).optional(),
    resourceMachines: z.array(FleetResourceMachineIdSchema).max(31).optional(),
    /** The owner's autonomy dial read back from the leaves (ADR 0263); absent on an older service. */
    autonomyLevel: AutonomyLevelReadingSchema.optional(),
    /** Present once the owner has chosen a level, from any device; clients ask only while it is absent (VUH-2725). */
    autonomyConfirmedAt: z.iso.datetime().optional(),
    autonomyDrift: AutonomyDriftSchema.optional(),
    /** Opt-in read; writes can change trust and autonomy together under one revision. */
    maximumTrustMode: z.boolean().optional(),
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
      .extend({
        ...FleetAutonomyPatchSchema.shape,
        hire: HireProfileSchema.nullable().optional(),
        /** Writes the level's leaves first; explicit leaves in the same change win. */
        autonomyLevel: AutonomyLevelSchema.optional(),
        /**
         * Records a choice the owner already made on a client that kept it only locally,
         * without changing a leaf (VUH-2725). A level change records it too.
         */
        autonomyConfirmed: z.literal(true).optional(),
        maximumTrustMode: z.boolean().optional(),
      })
      .refine(
        (value) => Object.values(value).some((field) => field !== undefined),
        "No fleet settings changes supplied",
      )
      .superRefine((value, ctx) => {
        for (const field of ["size", "models", "verification", "reportingStyle"] as const)
          if (value[field] !== undefined)
            ctx.addIssue({
              code: "custom",
              path: [field],
              message: "This prompt-only control is retired; saved values remain read-only.",
            });
        if (value.hire?.effort !== undefined)
          ctx.addIssue({
            code: "custom",
            path: ["hire", "effort"],
            message: "Fleet-wide effort is retired; choose effort and its reason per hire.",
          });
      }),
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
    /** Prepare only the selected local Herdr's pane launcher, or restore its prior shell. */
    claudePathShim: z.enum(["install", "remove"]).optional(),
  })
  .strict();
export type FleetPrepareRequest = z.infer<typeof FleetPrepareRequestSchema>;

/** Refresh only existing links; source-manager approvals remain their own recorded proof. */
export const FleetHarnessRefreshRequestSchema = FleetPrepareRequestSchema.omit({
  codexSourceSetup: true,
  claudePathShim: true,
  expectedMachineRevision: true,
});
export type FleetHarnessRefreshRequest = z.infer<typeof FleetHarnessRefreshRequestSchema>;

/**
 * Fleet hire defaults (VUH-1813): the harness, model and effort a hire uses
 * when its role and request name none. Unset is "no preference": Clankie
 * chooses per hire (ea54ebd6). Account, subagents, delegation and placement
 * stay where they are; this route never changes them.
 */
export const FLEET_HIRE_DEFAULTS_PATH = `${FLEET_SETTINGS_PATH}/hire`;
const HireDefaultsSchema = z
  .object({
    harness: z.enum(OPERATOR_SEAT_HARNESSES).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    effort: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export const FleetHireDefaultsSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** Covers the whole stored hire profile, so a concurrent account or subagent edit also fences. */
    revision: z.string().regex(/^[a-f0-9]{64}$/u),
    hire: HireDefaultsSchema,
    /** Requested with includeModels=true; values come from the host model registry. */
    agents: z
      .array(
        z
          .object({
            id: z.enum(OPERATOR_SEAT_HARNESSES),
            label: z.string(),
            models: z.array(z.object({ id: z.string().min(1).max(200), name: z.string() }).strict()),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type FleetHireDefaultsSnapshot = z.infer<typeof FleetHireDefaultsSnapshotSchema>;
/** Each field takes a value or `auto` (no preference, which clears it); omitted fields stay. */
export const UpdateFleetHireDefaultsSchema = z
  .object({
    schemaVersion: z.literal(1),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    changes: z
      .object({
        harness: z.union([z.enum(OPERATOR_SEAT_HARNESSES), z.literal(HIRE_NO_PREFERENCE)]).optional(),
        model: z.string().trim().min(1).max(200).optional(),
        effort: z.string().trim().min(1).max(64).optional(),
      })
      .strict()
      .refine(
        (value) => Object.values(value).some((field) => field !== undefined),
        "No hire default changes supplied",
      )
      .refine(
        (value) => value.effort === undefined || value.effort === HIRE_NO_PREFERENCE,
        "Fleet-wide effort is retired; select effort for each job.",
      ),
  })
  .strict();
export type UpdateFleetHireDefaults = z.infer<typeof UpdateFleetHireDefaultsSchema>;

/** Shared wording; `noPreference` matches `clankie fleet status`. */
export const FLEET_HIRE_DEFAULTS_WORDING = {
  title: "Who he hires",
  summary: "What a new worker runs unless its project says otherwise. Clankie decides anything left open.",
  noPreference: "No preference",
  harness: {
    label: "Coding agent",
    noPreferenceDetail: "Clankie picks Claude or Codex for each job, from the accounts with usage left.",
  },
  model: { label: "Model", noPreferenceDetail: "The coding agent picks its own model." },
  effort: { label: "Thinking effort", noPreferenceDetail: "Clankie sets it for each job." },
} as const;

/** The default lead seat's fresh restart (ADR 0271): its budget, last check and any refused wait (VUH-2821). */
export const FLEET_LEAD_RESTART_PATH = "/v1/fleet/lead-restart";
export const LeadRestartStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    conversationId: z.string().min(1).max(256),
    setting: z.enum(["on", "off"]),
    /** The restart is due at either bound. */
    budget: z
      .object({ contextTokens: z.number().int().positive(), ageHours: z.number().positive() })
      .strict(),
    /** A due restart refused this long tells the owner once. */
    noticeAfterMinutes: z.number().int().positive(),
    /** The latest check since the service started; absent before the first. */
    check: z
      .object({
        at: z.string().datetime(),
        contextTokens: z.number().int().nonnegative().optional(),
        sessionStartedAt: z.string().datetime().optional(),
        due: z.boolean(),
      })
      .strict()
      .optional(),
    /** Latest attempted check when the source/usage cannot establish the budget.
     * Keep the optional v1 `check` absent so older additive readers retain the wait. */
    unknownCheck: z
      .object({
        at: z.string().datetime(),
        contextTokens: z.number().int().nonnegative().optional(),
        sessionStartedAt: z.string().datetime().optional(),
      })
      .strict()
      .optional(),
    /** A due restart refused since `since`, kept across service restarts until it relaunches or is no longer due. */
    waiting: z
      .object({
        since: z.string().datetime(),
        lastAt: z.string().datetime(),
        lastReason: z.string().min(1).max(64),
        lastDetail: z.string().max(512).optional(),
        counts: z.record(z.string().min(1).max(64), z.number().int().positive()),
        noticedAt: z.string().datetime().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type LeadRestartStatus = z.infer<typeof LeadRestartStatusSchema>;
export type LeadRestartWait = NonNullable<LeadRestartStatus["waiting"]>;
