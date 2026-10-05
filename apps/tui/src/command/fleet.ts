import { effectiveHireProfile, FleetAutonomySchema, type FleetAutonomy } from "@clankie/protocol";
import { projectRolePolicy } from "@clankie/protocol/projects";
import { readFile } from "node:fs/promises";
import { HireProfileSchema } from "@clankie/protocol";
import {
  FLEET_MODEL_GUIDANCE,
  FLEET_MODEL_MODES,
  FLEET_SIZE_GUIDANCE,
  FLEET_CLOSURE_GUIDANCE,
  FLEET_MACHINE_SETUP_GUIDANCE,
  FLEET_SIZES,
  FleetSettingsSchema,
  SettingsStore,
  defaultSettingsPath,
  type FleetModelMode,
  type FleetSettings,
  type FleetSize,
} from "@clankie/settings";

const FLEET_USAGE = [
  "Usage: clankie fleet [status]",
  `       clankie fleet set [--notes TEXT] [--size ${FLEET_SIZES.join("|")}] [--models ${FLEET_MODEL_MODES.join("|")}] [--closure lead|owner] [--machine-setup lead|owner] [--tools connected|off] [--peer-messages on|off] [--hire-profile FILE.json]`,
  "       clankie fleet clear",
].join("\n");

export interface FleetCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly settings?: SettingsStore;
}

export interface FleetCommandResult {
  readonly ok: true;
  readonly fleet: FleetSettings & FleetAutonomy;
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
    `closure: ${fleet.closure ?? "lead"} — ${FLEET_CLOSURE_GUIDANCE[fleet.closure ?? "lead"]}`,
    `machine setup: ${fleet.machineSetup ?? "lead"} — ${FLEET_MACHINE_SETUP_GUIDANCE[fleet.machineSetup ?? "lead"]}`,
    `tools: ${fleet.tools} — ${fleet.tools === "off" ? "fleet tool access disabled" : "every verified connected server through clankie_tools and clankie_call"}`,
    `peer messages: ${fleet.peerMessages} — ${fleet.peerMessages === "off" ? "new messages between fleet workers disabled" : "proven native workers may message their own fleet"}`,
    `hire defaults: ${JSON.stringify(fleet.hire ?? {})}`,
    "routing preferences:",
    ...(notes.length === 0
      ? ["  (none — the default: he picks a harness per job on his own)"]
      : notes.split("\n").map((line) => `  ${line}`)),
  ];
}

async function result(settings: SettingsStore, fleet: FleetSettings): Promise<FleetCommandResult> {
  const config = await settings.load();
  return {
    ok: true,
    fleet: { ...fleet, ...config.autonomy.fleet },
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
  return await result(settings, (await settings.load()).fleet);
}

/** Merge the given fields into the stored fleet settings; a string alone updates the notes. */
export async function fleetUpdate(
  update: string | FleetUpdate,
  options: FleetCommandOptions = {},
): Promise<FleetCommandResult> {
  const change: FleetUpdate = typeof update === "string" ? { notes: update } : update;
  const settings = store(options);
  const { closure, machineSetup, ...fleetChange } = change;
  const updated = await settings.update((current) => ({
    ...current,
    fleet: FleetSettingsSchema.parse({ ...current.fleet, ...fleetChange }),
    autonomy: {
      ...current.autonomy,
      fleet: FleetAutonomySchema.parse({
        ...current.autonomy.fleet,
        ...(closure === undefined ? {} : { closure }),
        ...(machineSetup === undefined ? {} : { machineSetup }),
      }),
    },
  }));
  return await result(settings, updated.fleet);
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
  return change;
}

export async function runFleetCommand(
  args: readonly string[],
  options: FleetCommandOptions = {},
): Promise<FleetCommandResult> {
  const verb = args[0];
  if (verb === undefined || verb === "status") return await fleetStatus(options);
  // `clear` returns every field to its default: no notes, no plan limit.
  if (verb === "clear" && args.length === 1)
    return await fleetUpdate(
      { ...FleetSettingsSchema.parse({}), closure: "lead", machineSetup: "lead" },
      options,
    );
  if (verb === "set") return await fleetUpdate(await parseSet(args.slice(1)), options);
  throw new Error(FLEET_USAGE);
}
