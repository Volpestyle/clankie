import { SettingsStore, defaultSettingsPath, type GameplaySettings } from "@clankie/settings";

const GAMES_USAGE = "Usage: clankie games [status]\n       clankie games set on|off";

export interface GamesCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly settings?: SettingsStore;
}

export interface GamesCommandResult {
  readonly ok: true;
  readonly games: GameplaySettings;
  readonly settingsFile: string;
  readonly restart: string;
}

function store(options: GamesCommandOptions): SettingsStore {
  return options.settings ?? new SettingsStore(defaultSettingsPath(options.env ?? process.env));
}

export async function gamesStatus(options: GamesCommandOptions = {}): Promise<GamesCommandResult> {
  const settings = store(options);
  return {
    ok: true,
    games: (await settings.load()).gameplay,
    settingsFile: settings.path,
    restart: "clankie restart captain",
  };
}

export async function gamesSet(
  enabled: boolean,
  options: GamesCommandOptions = {},
): Promise<GamesCommandResult> {
  const settings = store(options);
  const updated = await settings.update((current) => ({
    ...current,
    gameplay: { ...current.gameplay, pokeagentMmoEnabled: enabled },
  }));
  return {
    ok: true,
    games: updated.gameplay,
    settingsFile: settings.path,
    restart: "clankie restart captain",
  };
}

export async function runGamesCommand(
  args: readonly string[],
  options: GamesCommandOptions = {},
): Promise<GamesCommandResult> {
  const verb = args[0];
  if (verb === undefined || verb === "status") return await gamesStatus(options);
  if (verb === "set" && args.length === 2 && (args[1] === "on" || args[1] === "off")) {
    return await gamesSet(args[1] === "on", options);
  }
  throw new Error(GAMES_USAGE);
}
