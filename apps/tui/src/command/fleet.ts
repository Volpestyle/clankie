import { SettingsStore, defaultSettingsPath, type FleetSettings } from "@clankie/settings";

const FLEET_USAGE = [
  "Usage: clankie fleet [status]",
  "       clankie fleet set --notes TEXT",
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

function store(options: FleetCommandOptions): SettingsStore {
  return options.settings ?? new SettingsStore(defaultSettingsPath(options.env ?? process.env));
}

export function formatFleetLines(fleet: FleetSettings): string[] {
  const notes = fleet.notes.trim();
  return [
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

export async function fleetUpdate(
  notes: string,
  options: FleetCommandOptions = {},
): Promise<FleetCommandResult> {
  const settings = store(options);
  const updated = await settings.update((current) => ({ ...current, fleet: { notes } }));
  return await result(settings, updated.fleet);
}

export async function runFleetCommand(
  args: readonly string[],
  options: FleetCommandOptions = {},
): Promise<FleetCommandResult> {
  const verb = args[0];
  if (verb === undefined || verb === "status") return await fleetStatus(options);
  if (verb === "clear" && args.length === 1) return await fleetUpdate("", options);
  if (verb === "set" && args.length === 3 && args[1] === "--notes") {
    const notes = args[2] ?? "";
    if (notes.length > 4_000) throw new Error("Keep --notes under 4000 characters.");
    return await fleetUpdate(notes, options);
  }
  throw new Error(FLEET_USAGE);
}
