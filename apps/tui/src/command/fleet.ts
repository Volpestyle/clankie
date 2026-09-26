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

const FLEET_USAGE = [
  "Usage: clankie fleet [status]",
  `       clankie fleet set [--notes TEXT] [--size ${FLEET_SIZES.join("|")}] [--models ${FLEET_MODEL_MODES.join("|")}]`,
  "       clankie fleet clear",
].join("\n");

export interface FleetCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly settings?: SettingsStore;
}

export interface FleetCommandResult {
  readonly ok: true;
  readonly fleet: FleetSettings;
  readonly settingsFile: string;
  readonly restart: string;
}

/** Any subset of the fleet settings; what is left out keeps its current value. */
export type FleetUpdate = Partial<FleetSettings>;

function store(options: FleetCommandOptions): SettingsStore {
  return options.settings ?? new SettingsStore(defaultSettingsPath(options.env ?? process.env));
}

export function formatFleetLines(fleet: FleetSettings): string[] {
  const notes = fleet.notes.trim();
  return [
    `swarm size: ${fleet.size} — ${FLEET_SIZE_GUIDANCE[fleet.size]}`,
    `models: ${fleet.models} — ${FLEET_MODEL_GUIDANCE[fleet.models]}`,
    "routing preferences:",
    ...(notes.length === 0
      ? ["  (none — the default: he picks a harness per job on his own)"]
      : notes.split("\n").map((line) => `  ${line}`)),
  ];
}

async function result(settings: SettingsStore, fleet: FleetSettings): Promise<FleetCommandResult> {
  return { ok: true, fleet, settingsFile: settings.path, restart: "clankie restart captain" };
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
  const updated = await settings.update((current) => ({
    ...current,
    fleet: FleetSettingsSchema.parse({ ...current.fleet, ...change }),
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
function parseSet(flags: readonly string[]): FleetUpdate {
  if (flags.length === 0 || flags.length % 2 !== 0) throw new Error(FLEET_USAGE);
  const change: { notes?: string; size?: FleetSize; models?: FleetModelMode } = {};
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1] ?? "";
    if (flag === "--notes" && change.notes === undefined) {
      if (value.length > 4_000) throw new Error("Keep --notes under 4000 characters.");
      change.notes = value;
    } else if (flag === "--size" && change.size === undefined) {
      if (!isSize(value)) throw new Error(`--size must be one of ${FLEET_SIZES.join(", ")}.`);
      change.size = value;
    } else if (flag === "--models" && change.models === undefined) {
      if (!isModelMode(value)) throw new Error(`--models must be one of ${FLEET_MODEL_MODES.join(", ")}.`);
      change.models = value;
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
  if (verb === "clear" && args.length === 1) return await fleetUpdate(FleetSettingsSchema.parse({}), options);
  if (verb === "set") return await fleetUpdate(parseSet(args.slice(1)), options);
  throw new Error(FLEET_USAGE);
}
