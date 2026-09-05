import { readHerdrBinding, type HerdrConnectionOptions } from "../session/herdr-connection.ts";
import type { HerdrBinding } from "@clankie/protocol";
import { SettingsStore, defaultSettingsPath, type HerdrSettings } from "@clankie/settings";

const HERDR_USAGE =
  "Usage: clankie herdr [status|open]\n       clankie herdr set --session NAME\n       clankie herdr set --runtime auto|bundled|external";

export interface HerdrCommandOptions extends Partial<HerdrConnectionOptions> {
  readonly env?: NodeJS.ProcessEnv;
  readonly settings?: SettingsStore;
}

export interface HerdrCommandResult {
  readonly ok: true;
  readonly herdr: HerdrSettings;
  readonly settingsFile: string;
  readonly restart: string;
  readonly active?: HerdrBinding;
  readonly unavailable?: string;
}

function store(options: HerdrCommandOptions): SettingsStore {
  return options.settings ?? new SettingsStore(defaultSettingsPath(options.env ?? process.env));
}

async function herdrStatus(options: HerdrCommandOptions = {}): Promise<HerdrCommandResult> {
  const settings = store(options);
  let live: { active?: HerdrBinding; unavailable?: string } = {};
  if (options.repoRoot !== undefined) {
    try {
      live = { active: await readHerdrBinding({ ...options, repoRoot: options.repoRoot }) };
    } catch (error) {
      live = { unavailable: error instanceof Error ? error.message : String(error) };
    }
  }
  return {
    ...live,
    ok: true,
    herdr: (await settings.load()).herdr,
    settingsFile: settings.path,
    restart: "clankie restart captain",
  };
}

async function herdrSet(
  patch: { session: string } | { runtime: HerdrSettings["runtime"] },
  options: HerdrCommandOptions = {},
): Promise<HerdrCommandResult> {
  const settings = store(options);
  const updated = await settings.update((current) => ({
    ...current,
    herdr:
      "session" in patch
        ? { runtime: "external", session: patch.session }
        : patch.runtime === "auto"
          ? { runtime: "auto", session: "default" }
          : patch.runtime === "external"
            ? { ...current.herdr, runtime: "external" }
            : { runtime: "bundled", session: current.herdr.session },
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
    return await herdrSet({ session: args[2] }, options);
  }
  if (verb === "set" && args.length === 3 && args[1] === "--runtime") {
    const runtime = args[2];
    if (runtime === "auto" || runtime === "bundled" || runtime === "external") {
      return await herdrSet({ runtime }, options);
    }
  }
  throw new Error(HERDR_USAGE);
}
