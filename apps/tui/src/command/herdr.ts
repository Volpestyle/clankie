import { SettingsStore, defaultSettingsPath, type HerdrSettings } from "@clankie/settings";

const HERDR_USAGE = "Usage: clankie herdr [status]\n       clankie herdr set --session NAME";

export interface HerdrCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly settings?: SettingsStore;
}

export interface HerdrCommandResult {
  readonly ok: true;
  readonly herdr: HerdrSettings;
  readonly settingsFile: string;
  readonly restart: string;
}

function store(options: HerdrCommandOptions): SettingsStore {
  return options.settings ?? new SettingsStore(defaultSettingsPath(options.env ?? process.env));
}

async function herdrStatus(options: HerdrCommandOptions = {}): Promise<HerdrCommandResult> {
  const settings = store(options);
  return {
    ok: true,
    herdr: (await settings.load()).herdr,
    settingsFile: settings.path,
    restart: "clankie restart captain",
  };
}

async function herdrSetSession(
  session: string,
  options: HerdrCommandOptions = {},
): Promise<HerdrCommandResult> {
  const settings = store(options);
  const updated = await settings.update((current) => ({
    ...current,
    herdr: { ...current.herdr, session },
  }));
  return {
    ok: true,
    herdr: updated.herdr,
    settingsFile: settings.path,
    restart: "clankie restart captain",
  };
}

export async function runHerdrCommand(
  args: readonly string[],
  options: HerdrCommandOptions = {},
): Promise<HerdrCommandResult> {
  const verb = args[0];
  if (verb === undefined || verb === "status") return await herdrStatus(options);
  if (verb === "set" && args.length === 3 && args[1] === "--session" && args[2] !== undefined) {
    return await herdrSetSession(args[2], options);
  }
  throw new Error(HERDR_USAGE);
}
