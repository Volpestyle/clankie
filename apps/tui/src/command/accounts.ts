import { resolveOperatorCredential } from "@clankie/credential-broker";
import { OauthAppsSettingsSchema, SettingsStore, defaultSettingsPath } from "@clankie/settings";
import { commandHost } from "./io.ts";

const ACCOUNTS_USAGE =
  "Usage: clankie accounts [list] | connect github | disconnect github|linear | apps [set|clear] [--github-client-id ID] [--linear-client-id ID] [--linear-redirect-uri URL]";

const APP_FLAGS = {
  "--github-client-id": ["github", "clientId"],
  "--linear-client-id": ["linear", "clientId"],
  "--linear-redirect-uri": ["linear", "redirectUri"],
} as const;

/**
 * The owner's GitHub and Linear account connections (ADR 0196). Tokens never
 * pass through here: the service runs each flow and keeps the result in the
 * credential broker; this prints the GitHub code to type and the outcome.
 */
export async function runAccountsCommand(
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly settings?: SettingsStore;
    readonly prompt?: (line: string) => void;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly request?: (path: string, body?: unknown) => Promise<Record<string, unknown>>;
  } = {},
): Promise<unknown> {
  const env = options.env ?? process.env;
  const request =
    options.request ??
    (async (path: string, body?: unknown) => {
      const credential = await resolveOperatorCredential({ env });
      if (!credential) throw new Error("Accounts need the operator credential. Run clankie doctor.");
      const response = await fetch(`${commandHost({ env })}${path}`, {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      return (await response.json()) as Record<string, unknown>;
    });

  if (args.length === 0 || (args.length === 1 && args[0] === "list")) return request("/v1/accounts");
  if (args.length === 2 && args[0] === "disconnect" && (args[1] === "github" || args[1] === "linear"))
    return request("/v1/accounts/disconnect", { provider: args[1] });
  if (args.length === 2 && args[0] === "connect" && args[1] === "github") {
    const prompt = options.prompt ?? ((line: string) => process.stderr.write(`${line}\n`));
    const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const start = await request("/v1/accounts/github/start", {});
    if (start.ok !== true) return start;
    prompt(`Open ${String(start.verificationUri)} and enter ${String(start.userCode)}`);
    let interval = Number(start.interval);
    for (;;) {
      await sleep(interval * 1000);
      const poll = await request("/v1/accounts/github/poll", { flowId: start.flowId });
      if (poll.ok !== true || poll.status !== "pending") return poll;
      interval = Number(poll.interval);
    }
  }
  if (args[0] === "apps") {
    if (options.request) throw new Error("OAuth application configuration is managed by the hosted service");
    const settings = options.settings ?? new SettingsStore(defaultSettingsPath(env));
    const action = args[1];
    if (args.length === 1 || (args.length === 2 && action === "status")) {
      const current = await settings.load();
      return { ok: true, oauthApps: current.oauthApps, settingsFile: settings.path };
    }
    if (action !== "set" && action !== "clear") throw new Error(ACCOUNTS_USAGE);
    const flags = args.slice(2);
    const changes: [keyof typeof APP_FLAGS, string | undefined][] = [];
    for (let i = 0; i < flags.length; i += 1) {
      const flag = flags[i] as keyof typeof APP_FLAGS;
      if (!(flag in APP_FLAGS)) throw new Error(ACCOUNTS_USAGE);
      if (action === "set") {
        const value = flags[i + 1];
        if (value === undefined) throw new Error(ACCOUNTS_USAGE);
        changes.push([flag, value]);
        i += 1;
      } else changes.push([flag, undefined]);
    }
    if (changes.length === 0) throw new Error(ACCOUNTS_USAGE);
    const current = await settings.update((value) => {
      const next = structuredClone(value.oauthApps) as Record<string, Record<string, string | undefined>>;
      for (const [flag, setting] of changes) {
        const [provider, field] = APP_FLAGS[flag];
        if (setting === undefined) delete next[provider]![field];
        else next[provider]![field] = setting;
      }
      return { ...value, oauthApps: OauthAppsSettingsSchema.parse(next) };
    });
    return { ok: true, oauthApps: current.oauthApps, settingsFile: settings.path };
  }
  throw new Error(ACCOUNTS_USAGE);
}
