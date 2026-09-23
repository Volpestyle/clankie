import { SettingsStore, defaultSettingsPath, type BrowserSettings } from "@clankie/settings";

const BROWSER_USAGE = "Usage: clankie browser [status]\n       clankie browser record on|off";

export interface BrowserCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly settings?: SettingsStore;
}

export interface BrowserCommandResult {
  readonly ok: true;
  readonly browser: BrowserSettings;
  readonly settingsFile: string;
  /** Read at the start of each browsing burst, so no restart is needed. */
  readonly appliesTo: "next_browsing_burst";
}

function store(options: BrowserCommandOptions): SettingsStore {
  return options.settings ?? new SettingsStore(defaultSettingsPath(options.env ?? process.env));
}

export async function browserStatus(options: BrowserCommandOptions = {}): Promise<BrowserCommandResult> {
  const settings = store(options);
  return {
    ok: true,
    browser: (await settings.load()).browser,
    settingsFile: settings.path,
    appliesTo: "next_browsing_burst",
  };
}

export async function browserSetRecording(
  enabled: boolean,
  options: BrowserCommandOptions = {},
): Promise<BrowserCommandResult> {
  const settings = store(options);
  const updated = await settings.update((current) => ({
    ...current,
    browser: { ...current.browser, recordSessions: enabled },
  }));
  return {
    ok: true,
    browser: updated.browser,
    settingsFile: settings.path,
    appliesTo: "next_browsing_burst",
  };
}

export async function runBrowserCommand(
  args: readonly string[],
  options: BrowserCommandOptions = {},
): Promise<BrowserCommandResult> {
  const verb = args[0];
  if (verb === undefined || verb === "status") return await browserStatus(options);
  if (verb === "record" && args.length === 2 && (args[1] === "on" || args[1] === "off")) {
    return await browserSetRecording(args[1] === "on", options);
  }
  throw new Error(BROWSER_USAGE);
}
