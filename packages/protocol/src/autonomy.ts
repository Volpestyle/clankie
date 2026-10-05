import { z } from "zod";

/** Owner-selected responsibility; never a credential, machine grant or action receipt. */
export const FleetAutonomyModeSchema = z.enum(["lead", "owner"]);
export type FleetAutonomyMode = z.infer<typeof FleetAutonomyModeSchema>;
export const FLEET_AUTONOMY_DEFAULTS = { closure: "lead", machineSetup: "lead" } as const;

export const FleetAutonomySchema = z
  .object({
    closure: FleetAutonomyModeSchema.default(FLEET_AUTONOMY_DEFAULTS.closure),
    machineSetup: FleetAutonomyModeSchema.default(FLEET_AUTONOMY_DEFAULTS.machineSetup),
  })
  .strict();
export type FleetAutonomy = z.infer<typeof FleetAutonomySchema>;

/** Shared owner policy block; future autonomy domains belong beside fleet. */
export const AutonomySettingsSchema = z
  .object({ fleet: FleetAutonomySchema.default(() => FleetAutonomySchema.parse({})) })
  .strict();
export type AutonomySettings = z.infer<typeof AutonomySettingsSchema>;

/** Missing project leaves inherit independently; never materialize global defaults here. */
export const FleetAutonomyOverridesSchema = z
  .object({
    closure: FleetAutonomyModeSchema.optional(),
    machineSetup: FleetAutonomyModeSchema.optional(),
  })
  .strict();
export type FleetAutonomyOverrides = z.infer<typeof FleetAutonomyOverridesSchema>;
export const ProjectAutonomySchema = z.object({ fleet: FleetAutonomyOverridesSchema.optional() }).strict();
export type ProjectAutonomy = z.infer<typeof ProjectAutonomySchema>;

/** Patch-only null removes one override and restores inheritance. */
export const FleetAutonomyPatchSchema = z
  .object({
    closure: FleetAutonomyModeSchema.nullable().optional(),
    machineSetup: FleetAutonomyModeSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    "No fleet autonomy changes supplied",
  );
export type FleetAutonomyPatch = z.infer<typeof FleetAutonomyPatchSchema>;
export const ProjectAutonomyPatchSchema = z.object({ fleet: FleetAutonomyPatchSchema }).strict();
export type ProjectAutonomyPatch = z.infer<typeof ProjectAutonomyPatchSchema>;

/** Resolving policy never supplies the host or account authority needed to act. */
export function effectiveFleetAutonomy(
  globalAutonomy: z.input<typeof AutonomySettingsSchema> | undefined,
  projectAutonomy?: ProjectAutonomy,
): FleetAutonomy {
  const global = AutonomySettingsSchema.parse(globalAutonomy ?? {});
  const project = ProjectAutonomySchema.parse(projectAutonomy ?? {});
  return {
    closure: project.fleet?.closure ?? global.fleet.closure,
    machineSetup: project.fleet?.machineSetup ?? global.fleet.machineSetup,
  };
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
} as const;
