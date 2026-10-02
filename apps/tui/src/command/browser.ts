import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { SettingsStore, defaultSettingsPath, type BrowserSettings } from "@clankie/settings";
import { commandHost } from "./io.ts";

const BROWSER_USAGE = [
  "Usage: clankie browser [status]",
  "       clankie browser record on|off",
  "       clankie browser delegate on|off",
  "       clankie browser harnesses",
].join("\n");

export interface BrowserCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly settings?: SettingsStore;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
}

export interface BrowserCommandResult {
  readonly ok: true;
  readonly browser: BrowserSettings;
  readonly settingsFile: string;
  /**
   * Recording is read at the start of each browsing burst; delegation when a
   * session is built. Neither needs a restart.
   */
  readonly appliesTo: "next_browsing_burst" | "next_session";
}

/** A computer-use harness as the service's detection reports it (ADR 0199). */
interface ComputerUseHarnessReport {
  readonly harness: string;
  readonly signedIn: boolean;
  readonly surfaces: readonly string[];
  readonly chromeNeedsHireFlag: boolean;
  readonly missing?: string;
}

export interface BrowserHarnessesResult {
  readonly ok: true;
  readonly schemaVersion: 1;
  /** False on a body with no owner desktop (hosted, or not macOS): nothing was probed. */
  readonly detected: boolean;
  readonly harnesses: readonly ComputerUseHarnessReport[];
  readonly harnessDelegation: boolean;
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

/** Whether his reach card offers computer-use harnesses (ADR 0199). */
export async function browserSetDelegation(
  enabled: boolean,
  options: BrowserCommandOptions = {},
): Promise<BrowserCommandResult> {
  const settings = store(options);
  const updated = await settings.update((current) => ({
    ...current,
    browser: { ...current.browser, harnessDelegation: enabled },
  }));
  return {
    ok: true,
    browser: updated.browser,
    settingsFile: settings.path,
    appliesTo: "next_session",
  };
}

/**
 * The service's own detection, re-probed on every read. It runs in the
 * service because that is the process whose card it feeds; asking it rather
 * than probing here keeps one answer.
 */
export async function browserHarnesses(options: BrowserCommandOptions = {}): Promise<BrowserHarnessesResult> {
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (credential?.token === undefined) {
    throw new Error("No operator credential is available; `clankie status` reports this install's.");
  }
  const response = await (options.fetchImpl ?? fetch)(
    new URL("/v1/browser/harnesses", commandHost({ ...options, env })),
    {
      headers: { authorization: `Bearer ${credential.token}` },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) throw new Error(`clankie service returned ${String(response.status)}`);
  const body = (await response.json()) as {
    detected: boolean;
    harnesses: readonly ComputerUseHarnessReport[];
  };
  return {
    ok: true,
    schemaVersion: 1,
    detected: body.detected,
    harnesses: body.harnesses,
    harnessDelegation: (await store(options).load()).browser.harnessDelegation,
  };
}

export async function runBrowserCommand(
  args: readonly string[],
  options: BrowserCommandOptions = {},
): Promise<BrowserCommandResult | BrowserHarnessesResult> {
  const verb = args[0];
  if (verb === undefined || verb === "status") return await browserStatus(options);
  if (verb === "harnesses" && args.length === 1) return await browserHarnesses(options);
  if (
    (verb === "record" || verb === "delegate") &&
    args.length === 2 &&
    (args[1] === "on" || args[1] === "off")
  ) {
    return verb === "record"
      ? await browserSetRecording(args[1] === "on", options)
      : await browserSetDelegation(args[1] === "on", options);
  }
  throw new Error(BROWSER_USAGE);
}
