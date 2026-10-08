import {
  EmbodimentBudgetSchema,
  GAME_EXTENSIONS_PATH,
  GameExtensionCatalogSchema,
  type GameExtensionCatalog,
  type EmbodimentBudget,
} from "@clankie/protocol";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";
import { SettingsStore, defaultSettingsPath, type GameplaySettings } from "@clankie/settings";

const GAMES_USAGE =
  "Usage: clankie games [status|extensions]\n       clankie games set on|off\n       clankie games budget max-tokens|max-cost-usd|max-turns|max-duration-ms <positive number|default>";

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

/** Installed body capabilities, read through the same authenticated API as every UI. */
export async function runGameExtensionsCommand(
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    operatorCredentialStore?: CredentialStore;
    request?: (path: string) => Promise<unknown>;
  } = {},
): Promise<GameExtensionCatalog> {
  if (options.request) return GameExtensionCatalogSchema.parse(await options.request(GAME_EXTENSIONS_PATH));
  const credential = await resolveOperatorCredential({
    env: options.env ?? process.env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (!credential)
    throw new Error("No operator credential is available; start the clankie service once first.");
  const response = await (options.fetchImpl ?? fetch)(new URL(GAME_EXTENSIONS_PATH, commandHost(options)), {
    headers: { authorization: `Bearer ${credential.token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`clankie service returned ${response.status}`);
  return GameExtensionCatalogSchema.parse(await response.json());
}

export async function gamesStatus(options: GamesCommandOptions = {}): Promise<GamesCommandResult> {
  const settings = store(options);
  return {
    ok: true,
    games: (await settings.load()).gameplay,
    settingsFile: settings.path,
    restart: "clankie restart",
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
    restart: "clankie restart",
  };
}

export async function gamesBudgetSet(
  key: keyof EmbodimentBudget,
  value: number | undefined,
  options: GamesCommandOptions = {},
): Promise<GamesCommandResult> {
  const settings = store(options);
  const updated = await settings.update((current) => {
    const budget = { ...current.gameplay.pokemonBudget };
    if (value === undefined) delete budget[key];
    else budget[key] = value;
    return {
      ...current,
      gameplay: { ...current.gameplay, pokemonBudget: EmbodimentBudgetSchema.parse(budget) },
    };
  });
  return { ok: true, games: updated.gameplay, settingsFile: settings.path, restart: "clankie restart" };
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
  if (verb === "budget" && args.length === 3) {
    const keys: Record<string, keyof EmbodimentBudget> = {
      "max-tokens": "maxTokens",
      "max-cost-usd": "maxCostUsd",
      "max-turns": "maxTurns",
      "max-duration-ms": "maxDurationMs",
    };
    const key = keys[args[1]!];
    if (key !== undefined)
      return gamesBudgetSet(key, args[2] === "default" ? undefined : Number(args[2]), options);
  }
  throw new Error(GAMES_USAGE);
}
