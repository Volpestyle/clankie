import {
  effectiveHireProfile,
  FleetAutonomySchema,
  FleetReleasePolicySchema,
  FleetVerificationSchema,
  FleetReportingStyleSchema,
  formatFleetAutonomyGuidance,
  type FleetAutonomy,
} from "@clankie/protocol";
import { projectRolePolicy } from "@clankie/protocol/projects";
import { readFile } from "node:fs/promises";
import { HireProfileSchema } from "@clankie/protocol";
import {
  FLEET_MODEL_GUIDANCE,
  FLEET_MODEL_MODES,
  FLEET_SIZE_GUIDANCE,
  FLEET_SIZES,
  FleetSettingsSchema,
  SettingsStore,
  defaultSettingsPath,
  type FleetModelMode,
  type FleetSettings,
  type FleetSize,
} from "@clankie/settings";
import { readWorkingPreferences, type WorkingPreferencesReport } from "./working-preferences.ts";
import type { machineSetupContext } from "./machine-setup.ts";

const FLEET_USAGE = [
  "Usage: clankie fleet [status [--working-directory PATH]]",
  `       clankie fleet set [--notes TEXT] [--size ${FLEET_SIZES.join("|")}] [--models ${FLEET_MODEL_MODES.join("|")}] [--closure lead|owner] [--machine-setup lead|owner] [--commit lead|owner] [--push lead|owner] [--release lead|owner|time_rule --release-rule TEXT] [--verification review_and_seal|change_run_read] [--report-style TEXT] [--tools connected|off] [--peer-messages on|off] [--hire-profile FILE.json]`,
  "       clankie fleet clear",
].join("\n");

export interface FleetCommandOptions extends NonNullable<Parameters<typeof machineSetupContext>[1]> {
  readonly settings?: SettingsStore;
}

export interface FleetCommandResult {
  readonly ok: true;
  readonly fleet: FleetSettings & FleetAutonomy;
  readonly workingPreferences: WorkingPreferencesReport;
  readonly roleProfiles: Array<{
    projectId: string;
    role: string;
    profile: ReturnType<typeof effectiveHireProfile>;
  }>;
  readonly settingsFile: string;
  readonly restart: string;
}

/** Any subset of the fleet settings; what is left out keeps its current value. */
export type FleetUpdate = Partial<FleetSettings & FleetAutonomy>;

function store(options: FleetCommandOptions): SettingsStore {
  return options.settings ?? new SettingsStore(defaultSettingsPath(options.env ?? process.env));
}

export function formatFleetLines(fleet: FleetSettings & Partial<FleetAutonomy>): string[] {
  const notes = fleet.notes.trim();
  return [
    `fleet size: ${fleet.size} — ${FLEET_SIZE_GUIDANCE[fleet.size]}`,
    `models: ${fleet.models} — ${FLEET_MODEL_GUIDANCE[fleet.models]}`,
    ...formatFleetAutonomyGuidance(FleetAutonomySchema.parse(fleetAutonomyFields(fleet))),
    `tools: ${fleet.tools} — ${fleet.tools === "off" ? "fleet tool access disabled" : "every verified connected server through clankie_tools and clankie_call"}`,
    `peer messages: ${fleet.peerMessages} — ${fleet.peerMessages === "off" ? "new messages between fleet workers disabled" : "proven native workers may message their own fleet"}`,
    `hire defaults: ${JSON.stringify(fleet.hire ?? {})}`,
    "routing preferences:",
    ...(notes.length === 0
      ? ["  (none — the default: he picks a harness per job on his own)"]
      : notes.split("\n").map((line) => `  ${line}`)),
  ];
}

function fleetAutonomyFields(value: Partial<FleetAutonomy>): Partial<FleetAutonomy> {
  const { closure, machineSetup, commit, push, release, verification, reportingStyle } = value;
  return Object.fromEntries(
    Object.entries({ closure, machineSetup, commit, push, release, verification, reportingStyle }).filter(
      ([, value]) => value !== undefined,
    ),
  );
}

async function result(
  settings: SettingsStore,
  fleet: FleetSettings,
  options: FleetCommandOptions,
): Promise<FleetCommandResult> {
  const config = await settings.load();
  return {
    ok: true,
    fleet: { ...fleet, ...config.autonomy.fleet },
    workingPreferences: await readWorkingPreferences(options),
    roleProfiles: config.projects.projects.flatMap((p) =>
      (p.roles.length
        ? p.roles
        : ["planner", "designer", "builder", "tester", "reviewer", "researcher"].map((role) => ({ role }))
      ).map((r) => ({
        projectId: p.id,
        role: r.role,
        profile: effectiveHireProfile({}, projectRolePolicy(p, r.role), fleet.hire),
      })),
    ),
    settingsFile: settings.path,
    restart: "clankie restart",
  };
}

export async function fleetStatus(options: FleetCommandOptions = {}): Promise<FleetCommandResult> {
  const settings = store(options);
  return await result(settings, (await settings.load()).fleet, options);
}

/** Merge the given fields into the stored fleet settings; a string alone updates the notes. */
export async function fleetUpdate(
  update: string | FleetUpdate,
  options: FleetCommandOptions = {},
): Promise<FleetCommandResult> {
  const change: FleetUpdate = typeof update === "string" ? { notes: update } : update;
  const settings = store(options);
  const { closure, machineSetup, commit, push, release, verification, reportingStyle, ...fleetChange } =
    change;
  const updated = await settings.update((current) => ({
    ...current,
    fleet: FleetSettingsSchema.parse({ ...current.fleet, ...fleetChange }),
    autonomy: {
      ...current.autonomy,
      fleet: FleetAutonomySchema.parse({
        ...current.autonomy.fleet,
        ...(closure === undefined ? {} : { closure }),
        ...(machineSetup === undefined ? {} : { machineSetup }),
        ...(commit === undefined ? {} : { commit }),
        ...(push === undefined ? {} : { push }),
        ...(release === undefined ? {} : { release }),
        ...(verification === undefined ? {} : { verification }),
        ...(reportingStyle === undefined ? {} : { reportingStyle }),
      }),
    },
  }));
  return await result(settings, updated.fleet, options);
}

function isSize(value: string): value is FleetSize {
  return (FLEET_SIZES as readonly string[]).includes(value);
}

function isModelMode(value: string): value is FleetModelMode {
  return (FLEET_MODEL_MODES as readonly string[]).includes(value);
}

/** `set` takes each flag at most once, each with a value; anything else is a usage error. */
async function parseSet(flags: readonly string[]): Promise<FleetUpdate> {
  if (flags.length === 0 || flags.length % 2 !== 0) throw new Error(FLEET_USAGE);
  const change: FleetUpdate = {};
  let releaseMode: string | undefined;
  let releaseRule: string | undefined;
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1] ?? "";
    if (flag === "--hire-profile" && change.hire === undefined) {
      const text = await readFile(value, "utf8");
      if (Buffer.byteLength(text) > 16 * 1024) throw new Error("Hire profile is too large");
      change.hire = HireProfileSchema.parse(JSON.parse(text));
    } else if (flag === "--notes" && change.notes === undefined) {
      if (value.length > 4_000) throw new Error("Keep --notes under 4000 characters.");
      change.notes = value;
    } else if (flag === "--size" && change.size === undefined) {
      if (!isSize(value)) throw new Error(`--size must be one of ${FLEET_SIZES.join(", ")}.`);
      change.size = value;
    } else if (flag === "--models" && change.models === undefined) {
      if (!isModelMode(value)) throw new Error(`--models must be one of ${FLEET_MODEL_MODES.join(", ")}.`);
      change.models = value;
    } else if (flag === "--closure" && change.closure === undefined) {
      if (value !== "lead" && value !== "owner") throw new Error("--closure must be lead or owner.");
      change.closure = value;
    } else if (flag === "--machine-setup" && change.machineSetup === undefined) {
      if (value !== "lead" && value !== "owner") throw new Error("--machine-setup must be lead or owner.");
      change.machineSetup = value;
    } else if (
      (flag === "--commit" || flag === "--push") &&
      change[flag === "--commit" ? "commit" : "push"] === undefined
    ) {
      if (value !== "lead" && value !== "owner") throw new Error(`${flag} must be lead or owner.`);
      change[flag === "--commit" ? "commit" : "push"] = value;
    } else if (flag === "--release" && releaseMode === undefined) {
      releaseMode = value;
    } else if (flag === "--release-rule" && releaseRule === undefined) {
      releaseRule = value;
    } else if (flag === "--verification" && change.verification === undefined) {
      change.verification = FleetVerificationSchema.parse(value);
    } else if (flag === "--report-style" && change.reportingStyle === undefined) {
      change.reportingStyle = FleetReportingStyleSchema.parse(value);
    } else if (flag === "--tools" && change.tools === undefined) {
      if (value !== "connected" && value !== "off") throw new Error("--tools must be connected or off.");
      change.tools = value;
    } else if (flag === "--peer-messages" && change.peerMessages === undefined) {
      if (value !== "on" && value !== "off") throw new Error("--peer-messages must be on or off.");
      change.peerMessages = value;
    } else {
      throw new Error(FLEET_USAGE);
    }
  }
  if (releaseMode !== undefined || releaseRule !== undefined)
    change.release = FleetReleasePolicySchema.parse({
      mode: releaseMode,
      ...(releaseRule === undefined ? {} : { rule: releaseRule }),
    });
  return change;
}

export async function runFleetCommand(
  args: readonly string[],
  options: FleetCommandOptions = {},
): Promise<FleetCommandResult> {
  const verb = args[0];
  if (verb === undefined || verb === "status") {
    if (args.length <= 1) return await fleetStatus(options);
    if (args.length === 3 && args[1] === "--working-directory" && args[2])
      return await fleetStatus({ ...options, cwd: args[2] });
    throw new Error(FLEET_USAGE);
  }
  // `clear` returns every field to its default: no notes, no plan limit.
  if (verb === "clear" && args.length === 1)
    return await fleetUpdate({ ...FleetSettingsSchema.parse({}), ...FleetAutonomySchema.parse({}) }, options);
  if (verb === "set") return await fleetUpdate(await parseSet(args.slice(1)), options);
  throw new Error(FLEET_USAGE);
}
