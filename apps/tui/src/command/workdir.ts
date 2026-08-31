import { homedir } from "node:os";
import { resolve } from "node:path";
import { SettingsStore, defaultSettingsPath } from "@clankie/settings";

const WORKDIR_USAGE =
  "Usage: clankie workdir [status]\n       clankie workdir set PATH\n       clankie workdir clear";

export interface WorkdirCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly settings?: SettingsStore;
}

export interface WorkdirCommandResult {
  readonly ok: true;
  /** The configured value; null when the captain uses the default. */
  readonly workingDirectory: string | null;
  /** What the captain actually runs in after a restart. */
  readonly effective: string;
  readonly settingsFile: string;
  readonly restart: string;
}

function store(options: WorkdirCommandOptions): SettingsStore {
  return options.settings ?? new SettingsStore(defaultSettingsPath(options.env ?? process.env));
}

function result(configured: string | undefined, settings: SettingsStore): WorkdirCommandResult {
  return {
    ok: true,
    workingDirectory: configured ?? null,
    effective: configured ?? homedir(),
    settingsFile: settings.path,
    restart: "clankie restart captain",
  };
}

async function workdirStatus(options: WorkdirCommandOptions = {}): Promise<WorkdirCommandResult> {
  const settings = store(options);
  return result((await settings.load()).captain.workingDirectory, settings);
}

async function workdirSet(path: string, options: WorkdirCommandOptions = {}): Promise<WorkdirCommandResult> {
  const settings = store(options);
  const expanded = path === "~" || path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path);
  const updated = await settings.update((current) => ({
    ...current,
    captain: { ...current.captain, workingDirectory: expanded },
  }));
  return result(updated.captain.workingDirectory, settings);
}

async function workdirClear(options: WorkdirCommandOptions = {}): Promise<WorkdirCommandResult> {
  const settings = store(options);
  const updated = await settings.update((current) => ({ ...current, captain: {} }));
  return result(updated.captain.workingDirectory, settings);
}

export async function runWorkdirCommand(
  args: readonly string[],
  options: WorkdirCommandOptions = {},
): Promise<WorkdirCommandResult> {
  const verb = args[0];
  if (verb === undefined || verb === "status") return await workdirStatus(options);
  if (verb === "set" && args.length === 2 && args[1] !== undefined && args[1].length > 0) {
    return await workdirSet(args[1], options);
  }
  if (verb === "clear" && args.length === 1) return await workdirClear(options);
  throw new Error(WORKDIR_USAGE);
}
