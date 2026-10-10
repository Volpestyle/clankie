import { z } from "zod";
import {
  FleetGatesSchema,
  FleetGateModeSchema,
  FLEET_GATE_FIELDS,
  FLEET_GATE_PRESETS,
  FLEET_GATE_CATEGORIES,
  FLEET_GATE_MODES,
  fleetGateSummary,
  type FleetGates,
} from "./fleet-gates.ts";
export * from "./fleet-gates.ts";

/** Owner-selected responsibility; never a credential, machine grant or action receipt. */
export const FleetAutonomyModeSchema = z.enum(["lead", "owner"]);
export type FleetAutonomyMode = z.infer<typeof FleetAutonomyModeSchema>;
export const FleetReleasePolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("lead") }).strict(),
  z.object({ mode: z.literal("owner") }).strict(),
  z.object({ mode: z.literal("time_rule"), rule: z.string().trim().min(1).max(2000) }).strict(),
]);
export type FleetReleasePolicy = z.infer<typeof FleetReleasePolicySchema>;
export const FleetVerificationSchema = z.enum(["review_and_seal", "change_run_read"]);
export type FleetVerification = z.infer<typeof FleetVerificationSchema>;
export const FleetReportingStyleSchema = z.string().trim().min(1).max(2000);

/** Owner-authored working preferences, without defaults for transport responses. */
export const FleetWorkingPreferencesSchema = z
  .object({
    commit: FleetAutonomyModeSchema,
    push: FleetAutonomyModeSchema,
    release: FleetReleasePolicySchema,
    verification: FleetVerificationSchema,
    reportingStyle: FleetReportingStyleSchema,
  })
  .strict();
export type FleetWorkingPreferences = z.infer<typeof FleetWorkingPreferencesSchema>;
export const FLEET_WORKING_PREFERENCE_FIELDS = [
  "commit",
  "push",
  "release",
  "verification",
  "reportingStyle",
] as const;
export const FLEET_AUTONOMY_FIELDS = [
  "closure",
  "machineSetup",
  ...FLEET_WORKING_PREFERENCE_FIELDS,
  ...FLEET_GATE_FIELDS,
] as const;

/**
 * One owner dial for how much Clankie decides without asking (ADR 0263).
 * Choosing a level writes these leaves; the level itself is never stored, so a
 * hand-set leaf reads back as `custom`. Whether he works at all is a separate
 * switch. Verification and reporting style are how work is done, not who
 * decides, and no level touches them.
 */
export const AutonomyLevelSchema = z.enum(["off", "low", "high", "full"]);
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;
export const AutonomyLevelReadingSchema = z.union([AutonomyLevelSchema, z.literal("custom")]);
export type AutonomyLevelReading = z.infer<typeof AutonomyLevelReadingSchema>;
export const DEFAULT_AUTONOMY_LEVEL = "high" satisfies AutonomyLevel;
export const AUTONOMY_LEVEL_FLEET_FIELDS = [
  ...FLEET_GATE_FIELDS,
  "closure",
  "machineSetup",
  "commit",
  "push",
  "release",
] as const;
export type AutonomyLevelFleet = FleetGates & {
  closure: FleetAutonomyMode;
  machineSetup: FleetAutonomyMode;
  commit: FleetAutonomyMode;
  push: FleetAutonomyMode;
  release: { mode: "lead" } | { mode: "owner" };
};
export const AUTONOMY_LEVELS = {
  off: {
    label: "Off",
    description:
      "Clankie decides nothing on his own: every worker question, commit, push, release, close and setup change waits for you.",
    fleet: {
      everydayWork: "owner",
      leavesMac: "owner",
      hardToUndo: "owner",
      moneyAndAccounts: "owner",
      closure: "owner",
      machineSetup: "owner",
      commit: "owner",
      push: "owner",
      release: { mode: "owner" },
    },
  },
  low: {
    label: "Low",
    description:
      "Clankie answers workers' everyday questions and commits; anything that leaves your Mac, is hard to undo, pushes, releases or closes work asks you.",
    fleet: {
      ...FLEET_GATE_PRESETS.careful.gates,
      closure: "owner",
      machineSetup: "owner",
      commit: "lead",
      push: "owner",
      release: { mode: "owner" },
    },
  },
  high: {
    label: "High",
    description:
      "Clankie takes every call he can: workers handle everyday work, he decides on outward and hard-to-undo changes, commits, pushes, sets up workers and closes work. Releases, money and accounts ask you.",
    fleet: {
      ...FLEET_GATE_PRESETS["hands-off"].gates,
      closure: "lead",
      machineSetup: "lead",
      commit: "lead",
      push: "lead",
      release: { mode: "owner" },
    },
  },
  full: {
    label: "Full",
    description:
      "Clankie decides everything but money and accounts, releases included, and workers act on outward work without stopping to ask.",
    fleet: {
      everydayWork: "allow",
      leavesMac: "allow",
      hardToUndo: "lead",
      moneyAndAccounts: "owner",
      closure: "lead",
      machineSetup: "lead",
      commit: "lead",
      push: "lead",
      release: { mode: "lead" },
    },
  },
} as const satisfies Record<AutonomyLevel, { label: string; description: string; fleet: AutonomyLevelFleet }>;

/** A fresh copy of the leaves a level writes. */
export function autonomyLevelFleet(level: AutonomyLevel): AutonomyLevelFleet {
  const { release, ...rest } = AUTONOMY_LEVELS[AutonomyLevelSchema.parse(level)].fleet;
  return { ...rest, release: { ...release } };
}

/** The level whose every leaf matches; a time-rule release or any other hand-set leaf reads as `custom`. */
export function matchingAutonomyLevel(
  fleet: Pick<FleetAutonomyWire, (typeof AUTONOMY_LEVEL_FLEET_FIELDS)[number]>,
): AutonomyLevelReading {
  return (
    AutonomyLevelSchema.options.find((level) => {
      const target = AUTONOMY_LEVELS[level];
      return AUTONOMY_LEVEL_FLEET_FIELDS.every((field) =>
        field === "release"
          ? fleet.release?.mode === target.fleet.release.mode
          : fleet[field] === target.fleet[field],
      );
    }) ?? "custom"
  );
}

export const FLEET_AUTONOMY_DEFAULTS = {
  ...AUTONOMY_LEVELS[DEFAULT_AUTONOMY_LEVEL].fleet,
  verification: "change_run_read",
  reportingStyle: "Short and plain.",
} satisfies FleetWorkingPreferences &
  FleetGates & { closure: FleetAutonomyMode; machineSetup: FleetAutonomyMode };

/** New response fields stay absent on an older service; defaults are a disk concern. */
export const FleetAutonomyWireSchema = z
  .object({
    closure: FleetAutonomyModeSchema,
    machineSetup: FleetAutonomyModeSchema,
    ...FleetWorkingPreferencesSchema.partial().shape,
    ...FleetGatesSchema.partial().shape,
  })
  .strict();
export type FleetAutonomyWire = z.infer<typeof FleetAutonomyWireSchema>;
export const AutonomySettingsWireSchema = z.object({ fleet: FleetAutonomyWireSchema }).strict();

export const FleetAutonomySchema = z
  .object({
    everydayWork: FleetGateModeSchema.default(FLEET_AUTONOMY_DEFAULTS.everydayWork),
    leavesMac: FleetGateModeSchema.default(FLEET_AUTONOMY_DEFAULTS.leavesMac),
    hardToUndo: FleetGateModeSchema.default(FLEET_AUTONOMY_DEFAULTS.hardToUndo),
    moneyAndAccounts: z.literal("owner").default("owner"),
    closure: FleetAutonomyModeSchema.default(FLEET_AUTONOMY_DEFAULTS.closure),
    machineSetup: FleetAutonomyModeSchema.default(FLEET_AUTONOMY_DEFAULTS.machineSetup),
    commit: FleetAutonomyModeSchema.default(FLEET_AUTONOMY_DEFAULTS.commit),
    push: FleetAutonomyModeSchema.default(FLEET_AUTONOMY_DEFAULTS.push),
    release: FleetReleasePolicySchema.default(() => ({ ...FLEET_AUTONOMY_DEFAULTS.release })),
    verification: FleetVerificationSchema.default(FLEET_AUTONOMY_DEFAULTS.verification),
    reportingStyle: FleetReportingStyleSchema.default(FLEET_AUTONOMY_DEFAULTS.reportingStyle),
  })
  .strict();
export type FleetAutonomy = z.infer<typeof FleetAutonomySchema>;

/** Shared owner policy block; future autonomy domains belong beside fleet. */
export const AutonomySettingsSchema = z
  .object({ fleet: FleetAutonomySchema.default(() => FleetAutonomySchema.parse({})) })
  .strict();
export type AutonomySettings = z.infer<typeof AutonomySettingsSchema>;

/** Missing project leaves inherit independently; never materialize global defaults here. */
export const FleetAutonomyOverridesSchema = FleetAutonomyWireSchema.partial();
export type FleetAutonomyOverrides = z.infer<typeof FleetAutonomyOverridesSchema>;
export const ProjectAutonomySchema = z.object({ fleet: FleetAutonomyOverridesSchema.optional() }).strict();
export type ProjectAutonomy = z.infer<typeof ProjectAutonomySchema>;

/** Patch-only null removes one override and restores inheritance. */
export const FleetAutonomyPatchSchema = z
  .object({
    everydayWork: FleetGateModeSchema.nullable().optional(),
    leavesMac: FleetGateModeSchema.nullable().optional(),
    hardToUndo: FleetGateModeSchema.nullable().optional(),
    moneyAndAccounts: z.literal("owner").nullable().optional(),
    closure: FleetAutonomyModeSchema.nullable().optional(),
    machineSetup: FleetAutonomyModeSchema.nullable().optional(),
    commit: FleetAutonomyModeSchema.nullable().optional(),
    push: FleetAutonomyModeSchema.nullable().optional(),
    release: FleetReleasePolicySchema.nullable().optional(),
    verification: FleetVerificationSchema.nullable().optional(),
    reportingStyle: FleetReportingStyleSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    "No fleet autonomy changes supplied",
  );
export type FleetAutonomyPatch = z.infer<typeof FleetAutonomyPatchSchema>;
export const ProjectAutonomyPatchSchema = z.object({ fleet: FleetAutonomyPatchSchema }).strict();
export type ProjectAutonomyPatch = z.infer<typeof ProjectAutonomyPatchSchema>;

/** Release is one leaf: replacing its mode also replaces its entire rule. */
export function applyFleetAutonomyPatch(
  current: FleetAutonomyOverrides | undefined,
  patch: FleetAutonomyPatch,
): FleetAutonomyOverrides {
  const next: Record<string, unknown> = { ...FleetAutonomyOverridesSchema.parse(current ?? {}) };
  for (const [field, value] of Object.entries(FleetAutonomyPatchSchema.parse(patch))) {
    if (value === null) delete next[field];
    else if (value !== undefined) next[field] = value;
  }
  return FleetAutonomyOverridesSchema.parse(next);
}

/** Resolving policy never supplies the host or account authority needed to act. */
export function effectiveFleetAutonomy(
  globalAutonomy: z.input<typeof AutonomySettingsSchema> | undefined,
  projectAutonomy?: ProjectAutonomy,
): FleetAutonomy {
  const global = AutonomySettingsSchema.parse(globalAutonomy ?? {});
  const project = ProjectAutonomySchema.parse(projectAutonomy ?? {});
  const overrides = Object.fromEntries(
    Object.entries(project.fleet ?? {}).filter(([, value]) => value !== undefined),
  );
  return FleetAutonomySchema.parse({ ...global.fleet, ...overrides });
}

export const FLEET_CLOSURE_GUIDANCE = {
  lead: "The lead closes work to Done after it has landed, relevant checks pass, and evidence is attached. The owner may reopen it.",
  owner: "Park completed work In Review for the owner to close. The owner may reopen it.",
} as const satisfies Record<FleetAutonomyMode, string>;
export const FLEET_MACHINE_SETUP_GUIDANCE = {
  lead: "The lead and workers may install, refresh, and prepare Clankie’s own harness plugins, bridges, and worker setup on already-linked machines. This grants no steering of existing lanes, restarts, credentials, accounts, or destructive actions.",
  owner:
    "Ask the owner before installing, refreshing, or preparing agent plugins, bridges, or worker setup. Existing lanes, restarts, credentials, accounts, and destructive actions remain outside this setting.",
} as const satisfies Record<FleetAutonomyMode, string>;
export const FLEET_AUTONOMY_GUIDANCE = {
  closure: FLEET_CLOSURE_GUIDANCE,
  machineSetup: FLEET_MACHINE_SETUP_GUIDANCE,
  commit: {
    lead: "The lead may commit completed work without routine owner confirmation.",
    owner: "Ask the owner before committing completed work.",
  },
  push: {
    lead: "The lead may push completed work without routine owner confirmation.",
    owner: "Ask the owner before pushing completed work.",
  },
  release: {
    lead: "The lead may publish a release after relevant release checks pass.",
    owner: "Ask the owner before publishing an official release.",
    time_rule: "Publish a release only when the owner-authored time rule is satisfied.",
  },
  verification: {
    review_and_seal:
      "Have an independent reviewer check the completed change, address findings, then seal the reviewed revision with its verification evidence.",
    change_run_read:
      "Make the change, run focused relevant checks, and read their results before reporting completion.",
  },
  reportingStyle: "Use the owner-authored reporting style when reporting progress and results.",
} as const;

/** Standing work guidance; it never changes the account or host authority of a caller. */
export function formatFleetAutonomyGuidance(policy: FleetAutonomy): string[] {
  const fleet = FleetAutonomySchema.parse(policy);
  return [
    `Work closure: ${fleet.closure}. ${FLEET_AUTONOMY_GUIDANCE.closure[fleet.closure]}`,
    `Machine setup: ${fleet.machineSetup}. ${FLEET_AUTONOMY_GUIDANCE.machineSetup[fleet.machineSetup]}`,
    `Commit: ${fleet.commit}. ${FLEET_AUTONOMY_GUIDANCE.commit[fleet.commit]}`,
    `Push: ${fleet.push}. ${FLEET_AUTONOMY_GUIDANCE.push[fleet.push]}`,
    `Release: ${fleet.release.mode}. ${FLEET_AUTONOMY_GUIDANCE.release[fleet.release.mode]}${fleet.release.mode === "time_rule" ? ` Rule: ${fleet.release.rule}` : ""}`,
    `Verification: ${fleet.verification}. ${FLEET_AUTONOMY_GUIDANCE.verification[fleet.verification]}`,
    `Reporting style: ${fleet.reportingStyle}`,
    `Worker gates: ${fleetGateSummary(fleet)}`,
    ...FLEET_GATE_CATEGORIES.map(
      (category) =>
        `${category.label}: ${fleet[category.key]}. ${FLEET_GATE_MODES[fleet[category.key]].description}`,
    ),
  ];
}
