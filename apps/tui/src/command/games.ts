import {
  EmbodimentBudgetSchema,
  GAME_EXTENSIONS_PATH,
  GameExtensionCatalogSchema,
  type GameExtensionCatalog,
  type EmbodimentBudget,
} from "@clankie/protocol";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";
import {
  GameExtensionModuleEntrySchema,
  SettingsStore,
  defaultSettingsPath,
  type GameplaySettings,
} from "@clankie/settings";

const GAMES_USAGE =
  "Usage: clankie games [status|extensions]\n       clankie games set on|off\n       clankie games budget max-tokens|max-cost-usd|max-turns|max-duration-ms <positive number|default>\n       clankie games extensions add MODULE [KEY=VALUE...] | remove MODULE";

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

/**
 * Install or replace an external game extension by its absolute module path
 * (ADR 0234). Options are non-secret values for that module; credentials go
 * through `/auth`. Applies on `clankie restart`.
 */
export async function gamesExtensionAdd(
  module: string,
  options: Readonly<Record<string, string>>,
  command: GamesCommandOptions = {},
): Promise<GamesCommandResult> {
  const entry = GameExtensionModuleEntrySchema.parse({
    module,
    ...(Object.keys(options).length === 0 ? {} : { options }),
  });
  const settings = store(command);
  const updated = await settings.update((current) => ({
    ...current,
    gameplay: {
      ...current.gameplay,
      extensions: [
        ...(current.gameplay.extensions ?? []).filter((installed) => installed.module !== entry.module),
        entry,
      ],
    },
  }));
  return { ok: true, games: updated.gameplay, settingsFile: settings.path, restart: "clankie restart" };
}

export async function gamesExtensionRemove(
  module: string,
  command: GamesCommandOptions = {},
): Promise<GamesCommandResult> {
  const settings = store(command);
  const updated = await settings.update((current) => {
    const extensions = (current.gameplay.extensions ?? []).filter((installed) => installed.module !== module);
    if (extensions.length === (current.gameplay.extensions ?? []).length)
      throw new Error(`No installed game extension has module ${module}`);
    const { extensions: _old, ...gameplay } = current.gameplay;
    return { ...current, gameplay: extensions.length === 0 ? gameplay : { ...gameplay, extensions } };
  });
  return { ok: true, games: updated.gameplay, settingsFile: settings.path, restart: "clankie restart" };
}

/** `extensions add MODULE [KEY=VALUE...]` or `extensions remove MODULE`; undefined when not that shape. */
export async function runGameExtensionInstallCommand(
  args: readonly string[],
  options: GamesCommandOptions = {},
): Promise<GamesCommandResult | undefined> {
  const [noun, verb, module, ...rest] = args;
  if (noun !== "extensions" || module === undefined) return undefined;
  if (verb === "remove" && rest.length === 0) return gamesExtensionRemove(module, options);
  if (verb !== "add") return undefined;
  const values: Record<string, string> = {};
  for (const pair of rest) {
    const split = pair.indexOf("=");
    if (split < 1) throw new Error(GAMES_USAGE);
    values[pair.slice(0, split)] = pair.slice(split + 1);
  }
  return gamesExtensionAdd(module, values, options);
}

export async function runGamesCommand(
  args: readonly string[],
  options: GamesCommandOptions = {},
): Promise<GamesCommandResult> {
  const verb = args[0];
  if (verb === undefined || verb === "status") return await gamesStatus(options);
  const installed = await runGameExtensionInstallCommand(args, options);
  if (installed !== undefined) return installed;
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
