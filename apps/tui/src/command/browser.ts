import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { SettingsStore, defaultSettingsPath, type BrowserSettings } from "@clankie/settings";
import { commandHost } from "./io.ts";
import {
  BodyLeaseResultSchema,
  type BodyLeaseResult,
  BrowserToolCatalogSchema,
  CallBrowserToolRequestSchema,
  CallBrowserToolResultSchema,
  type BrowserToolCatalog,
  type CallBrowserToolResult,
} from "@clankie/protocol";

const BROWSER_USAGE = [
  "Usage: clankie browser [status]",
  "       clankie browser record on|off",
  "       clankie browser delegate on|off",
  "       clankie browser harnesses",
  "       clankie browser tools",
  "       clankie browser call TOOL JSON --conversation ID",
].join("\n");

export interface BrowserCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly conversationId?: string;
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
  readonly platform?: "darwin" | "win32";
  readonly machineId?: string;
}

export interface BrowserHarnessesResult {
  readonly ok: true;
  readonly schemaVersion: 1;
  /** False when owner-machine and fleet detection are not configured (hosted). */
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
): Promise<
  BrowserCommandResult | BrowserHarnessesResult | BrowserToolCatalog | CallBrowserToolResult | BodyLeaseResult
> {
  const verb = args[0];
  if (verb === undefined || verb === "status") return await browserStatus(options);
  if (verb === "harnesses" && args.length === 1) return await browserHarnesses(options);
  if (verb === "tools" && args.length === 1) {
    const body = await browserRequest("/v1/browser/tools", options);
    return BrowserToolCatalogSchema.parse(body.catalog);
  }
  if (verb === "call" && (args.length === 3 || (args.length === 5 && args[3] === "--conversation"))) {
    const request = CallBrowserToolRequestSchema.parse({
      schemaVersion: 1,
      tool: args[1],
      arguments: JSON.parse(args[2] ?? "{}"),
    });
    const selected =
      args[4] ?? options.conversationId ?? (options.env ?? process.env).CLANKIE_CONVERSATION_ID;
    const body = await browserRequest(
      "/v1/browser/call",
      { ...options, ...(selected === undefined ? {} : { conversationId: selected }) },
      request,
    );
    const lease = BodyLeaseResultSchema.safeParse(body.result);
    return lease.success ? lease.data : CallBrowserToolResultSchema.parse(body.result);
  }
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

async function browserRequest(
  path: string,
  options: BrowserCommandOptions,
  request?: unknown,
): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  });
  if (!credential?.token)
    throw new Error("No operator credential is available; `clankie status` reports this install's.");
  const response = await (options.fetchImpl ?? fetch)(new URL(path, commandHost({ ...options, env })), {
    method: request === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${credential.token}`,
      "content-type": "application/json",
      ...(options.conversationId === undefined
        ? {}
        : { "x-clankie-conversation-id": options.conversationId }),
    },
    ...(request === undefined ? {} : { body: JSON.stringify(request) }),
    signal: AbortSignal.timeout(150_000),
  });
  if (!response.ok) throw new Error(`clankie service returned ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}
