import { closeSync, existsSync, globSync, openSync, readSync, statSync, readFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ClankieSettingsSchema, dropRetiredSettings, type ClankieSettings } from "./schema.ts";
import { readCodexHookTrust, readCodexRateLimits } from "./codex-rate-limits.ts";
import { defaultSettingsPath, SettingsStore } from "./store.ts";

export interface CodexAccount {
  label: string;
  home: string;
}
interface CodexWindow {
  used_percent: number;
  window_minutes: number;
  resets_at?: number;
}
interface CodexSnapshot {
  primary?: CodexWindow;
  secondary?: CodexWindow;
  rate_limit_reached_type?: unknown;
}

export interface CodexRateLimit {
  five_hour: number | null;
  seven_day: number | null;
  resets: { five_hour: number | null; seven_day: number | null };
  limited: boolean;
}

/** Shared with the eval usage guard. Never opens credentials. */
export function codexRateLimit(text: string): CodexRateLimit | null {
  let latest: CodexSnapshot | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes('"rate_limits"')) continue;
    try {
      latest = JSON.parse(line).payload?.rate_limits ?? latest;
    } catch {
      /* partial line */
    }
  }
  if (!latest) return null;
  const result: CodexRateLimit = {
    five_hour: null,
    seven_day: null,
    resets: { five_hour: null, seven_day: null },
    limited: Boolean(latest.rate_limit_reached_type),
  };
  for (const window of [latest.primary, latest.secondary]) {
    if (!window || !Number.isFinite(window.used_percent) || !Number.isFinite(window.window_minutes)) continue;
    const name = window.window_minutes <= 300 ? "five_hour" : "seven_day";
    result[name] = Math.max(0, Math.min(1, window.used_percent / 100));
    result.resets[name] =
      typeof window.resets_at === "number" && Number.isFinite(window.resets_at) ? window.resets_at : null;
  }
  return result;
}

/** The default account remains implicit; settings contain only extra homes and labels. */
export function codexAccounts(
  settings?: Pick<ClankieSettings, "codexAccounts">,
  env: NodeJS.ProcessEnv = process.env,
): CodexAccount[] {
  if (!settings) {
    const path = defaultSettingsPath(env);
    settings = existsSync(path)
      ? ClankieSettingsSchema.parse(dropRetiredSettings(JSON.parse(readFileSync(path, "utf8"))))
      : { codexAccounts: [] };
  }
  return [{ label: "default", home: env.CODEX_HOME ?? join(homedir(), ".codex") }, ...settings.codexAccounts];
}

export function codexAccountStatus(account: CodexAccount, now = Date.now()) {
  let rateLimits: CodexRateLimit | null = null;
  let observedAt: string | null = null;
  // Read bounded tails of recent rollout files, never prompts or auth into logs.
  let rollouts: string[] = [];
  try {
    rollouts = globSync("**/*.jsonl", { cwd: join(account.home, "sessions") }).map((name) =>
      join(account.home, "sessions", name),
    );
  } catch {
    /* unreadable home has unknown usage */
  }
  const files = rollouts
    .flatMap((path) => {
      try {
        return [{ path, mtime: statSync(path).mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 20);
  for (const file of files) {
    let fd: number | undefined;
    try {
      fd = openSync(file.path, "r");
      const size = statSync(file.path).size;
      const bytes = Buffer.alloc(Math.min(size, 1024 * 1024));
      readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
      const text = bytes.toString("utf8");
      const candidate = codexRateLimit(text);
      if (!candidate) continue;
      let timestamp: string | null = null;
      for (const line of text.split("\n").reverse()) {
        try {
          const event = JSON.parse(line);
          if (event.payload?.rate_limits) {
            timestamp =
              typeof event.timestamp === "string" && Number.isFinite(Date.parse(event.timestamp))
                ? new Date(event.timestamp).toISOString()
                : null;
            break;
          }
        } catch {
          /* partial line */
        }
      }
      if (
        rateLimits === null ||
        (timestamp !== null && Date.parse(timestamp) > (observedAt === null ? 0 : Date.parse(observedAt)))
      ) {
        rateLimits = candidate;
        observedAt = timestamp;
      }
    } catch {
      /* unavailable telemetry is unknown, never zero usage */
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return accountStatus(account, rateLimits, observedAt, now);
}

function accountStatus(
  account: CodexAccount,
  rateLimits: CodexRateLimit | null,
  observedAt: string | null,
  now: number,
) {
  const fresh =
    observedAt !== null &&
    Number.isFinite(Date.parse(observedAt)) &&
    now - Date.parse(observedAt) >= -60_000 &&
    now - Date.parse(observedAt) <= 24 * 3600_000;
  const remaining =
    rateLimits && fresh
      ? (["five_hour", "seven_day"] as const).flatMap((key) => {
          const used = rateLimits![key];
          const reset = rateLimits!.resets[key];
          return used === null ? [] : [reset !== null && reset * 1000 <= now ? 1 : 1 - used];
        })
      : [];
  const limited =
    fresh &&
    rateLimits?.limited &&
    (remaining.length === 0 ||
      !(["five_hour", "seven_day"] as const)
        .filter((key) => rateLimits[key] !== null)
        .every((key) => rateLimits.resets[key] !== null && rateLimits.resets[key]! * 1000 <= now));
  const headroom = limited ? 0 : remaining.length > 0 ? Math.min(...remaining) : null;
  return {
    ...account,
    authPresent: existsSync(join(account.home, "auth.json")),
    rateLimits,
    observedAt,
    headroom,
  };
}

export function selectCodexAccount(accounts: readonly CodexAccount[], label?: string) {
  return chooseAccount(
    accounts.map((account) => codexAccountStatus(account)),
    label,
  );
}

/** Prefer current account quota, including homes with no rollout yet. */
export async function readCodexAccountStatus(account: CodexAccount) {
  const [hookTrust, text] = await Promise.all([
    readCodexHookTrust(account.home).catch(() => "unknown" as const),
    existsSync(join(account.home, "auth.json"))
      ? readCodexRateLimits(account.home).catch(() => null)
      : Promise.resolve(null),
  ]);
  const limits = text === null ? null : codexRateLimit(text);
  if (limits && (limits.five_hour !== null || limits.seven_day !== null || limits.limited))
    return { ...accountStatus(account, limits, new Date().toISOString(), Date.now()), hookTrust };
  return { ...codexAccountStatus(account), hookTrust };
}

export async function selectLiveCodexAccount(accounts: readonly CodexAccount[], label?: string) {
  if (label !== undefined && !accounts.some((account) => account.label === label))
    throw new Error(`Unknown Codex account: ${label}`);
  return chooseAccount(
    await Promise.all(
      accounts
        .filter((account) => label === undefined || account.label === label)
        .map(readCodexAccountStatus),
    ),
    label,
  );
}

function chooseAccount(statuses: ReturnType<typeof codexAccountStatus>[], label?: string) {
  if (label !== undefined) {
    const selected = statuses.find((account) => account.label === label);
    if (!selected) throw new Error(`Unknown Codex account: ${label}`);
    if (!selected.authPresent)
      throw new Error(`Codex account ${label} has no sign-in; the owner must sign in to its home.`);
    return selected;
  }
  const available = statuses.filter((account) => account.authPresent);
  // Known headroom wins; unknown beats exhausted. Registry order breaks ties.
  const rank = (headroom: number | null) => (headroom === null ? 1 : headroom > 0 ? 2 : 0);
  available.sort((a, b) => rank(b.headroom) - rank(a.headroom) || (b.headroom ?? 0) - (a.headroom ?? 0));
  if (!available[0]) throw new Error("No registered Codex account has a sign-in; the owner must sign in.");
  return available[0];
}

export async function registerCodexAccount(
  store: Pick<SettingsStore, "load" | "update">,
  account: CodexAccount,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const home = await realpath(
    resolve(account.home.startsWith("~/") ? `${homedir()}/${account.home.slice(2)}` : account.home),
  );
  if (!(await stat(home)).isDirectory()) throw new Error("Codex home must be a directory");
  const defaultHome = codexAccounts({ codexAccounts: [] }, env)[0]!.home;
  if (home === (await realpath(defaultHome).catch(() => defaultHome)))
    throw new Error("The default Codex home is already registered");
  await store.update((current) => {
    if (current.codexAccounts.some((existing) => existing.label === account.label || existing.home === home))
      throw new Error("Codex account label or home is already registered");
    return { ...current, codexAccounts: [...current.codexAccounts, { label: account.label, home }] };
  });
}

export async function removeCodexAccount(
  store: Pick<SettingsStore, "load" | "update">,
  label: string,
): Promise<void> {
  if (label === "default") throw new Error("The default Codex account is implicit and cannot be removed");
  await store.update((current) => ({
    ...current,
    codexAccounts: current.codexAccounts.filter((account) => account.label !== label),
  }));
}
