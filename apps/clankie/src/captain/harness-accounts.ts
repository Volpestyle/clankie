import { execFile } from "node:child_process";
import { posix, win32 } from "node:path";
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  codexAccounts,
  codexRateLimit,
  codexStatusFromLimits,
  type ClankieSettings,
} from "@clankie/settings";
import type { AccountUsage, MachineAllocation } from "@clankie/protocol/worker-accounts";
import { allocateAccounts, rankedAccounts } from "./account-allocation.ts";
import {
  CLAUDE_USAGE_MIN_VERSION_NUMBER,
  claudeUsageLines,
  claudeUsageWindows,
  codexUsageWindows,
  exhaustedUntil,
  usageHeadroom,
} from "./harness-usage.ts";
import {
  remoteProgramCommand,
  type FleetShellRun,
  type HerdrFleet,
  type HerdrSshTransport,
} from "../herdr-fleet.ts";

/**
 * Which Claude profiles and Codex homes a machine has, and whether each can
 * take a worker now (VUH-1527). A linked machine answers for itself: the probe
 * runs there through the fleet link, asks each profile's own CLI
 * (`claude auth status` and `claude -p /usage`, Codex's app-server
 * `account/read` and `account/rateLimits/read`) and returns identity, plan and
 * usage only. It
 * never reads, prints or moves a credential, and never starts a login or turn.
 *
 * Profiles are the machine's default home plus every `~/.claude-<label>` and
 * `~/.codex-<label>` directory, the same convention `clankie herdr prepare`
 * uses to install the worker plugin into each Claude profile.
 */

export type WorkerAccountHarness = "claude" | "codex" | "pi" | "prime";

/** Prime Agent API-key spend over one period, from its own transcripts. */
interface PrimeSpendPeriod {
  costUsd: number;
  tokens: number;
}
export interface PrimeSpend {
  readonly source: "prime-transcripts";
  readonly observedAt: string;
  /** Since local midnight. */
  readonly today: PrimeSpendPeriod;
  /** The last seven days. */
  readonly week: PrimeSpendPeriod;
}
const WORKER_ACCOUNT_HARNESSES: readonly WorkerAccountHarness[] = ["claude", "codex"];

export interface WorkerAccountStatus {
  readonly harness: WorkerAccountHarness;
  readonly label: string;
  /** The profile home on its own machine. */
  readonly home: string;
  readonly signedIn: boolean | null;
  /** The account's email as its CLI reports it; never a token. */
  readonly identity?: string;
  readonly plan?: string;
  /** The plan's rate-limit tier as the harness caches it for this sign-in, e.g. Claude's `default_claude_max_20x`. */
  readonly tier?: string;
  /** Lowest remaining fraction of the account's all-model usage windows; null when unobserved. */
  readonly headroom: number | null;
  readonly resetsAt?: string;
  /** The windows behind `headroom`, with their source and observation time. */
  readonly usage?: AccountUsage;
  /** Claude: whether Clankie's worker plugin is installed in this profile. */
  readonly workerPlugin?: boolean;
  /** The owner set this account aside from automatic choice. */
  readonly held?: { readonly reason?: string };
  /** Whether Clankie would hire on it now, and why not. */
  readonly usable: boolean;
  readonly models?: readonly string[];
  /** Prime Agent: how this provider is signed in to Prime, never the credential. */
  readonly credential?: "api_key" | "subscription";
  /** Prime Agent: an API key's spend. */
  readonly spend?: PrimeSpend;
  /** Prime Agent: the registered account whose limits this subscription draws from. */
  readonly sharesLimitsWith?: { readonly harness: "claude" | "codex"; readonly label: string };
  /**
   * The ChatGPT account a Codex home (as its app-server reports it) or Prime's
   * ChatGPT sign-in belongs to. Only for matching inside the reader; no report
   * leaves it with this.
   */
  readonly chatgptAccountId?: string;
  readonly reason?: string;
}

export interface MachineWorkerAccounts {
  readonly machine: string;
  readonly shell: HerdrSshTransport["shell"];
  readonly observedAt: string;
  readonly accounts: readonly WorkerAccountStatus[];
  /** A harness the machine could not answer for, with why. */
  readonly unavailable?: Partial<Record<WorkerAccountHarness, string>>;
  /** How Clankie would spread hires over these accounts now (VUH-1974). */
  readonly allocation?: MachineAllocation;
}

export interface WorkerAccountHold {
  readonly machine: string;
  readonly harness: WorkerAccountHarness;
  readonly label: string;
  readonly reason?: string | undefined;
}

const LABEL = /^[a-z][a-z0-9_-]{0,63}$/u;

// Runs once through the machine's own Node (the worker prerequisite). Only
// labels, homes, sign-in state, email, plan and usage windows leave it.
const PROBE = String.raw`
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), cp = require("node:child_process");
const input = JSON.parse(process.argv[1]);
const windows = process.platform === "win32";
const home = (windows ? process.env.USERPROFILE : process.env.HOME) || os.homedir();
const label = /^[a-z][a-z0-9_-]{0,63}$/;
const dirs = (prefix, extra) => {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(home, { withFileTypes: true }); } catch {}
  for (const entry of names) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix + "-")) continue;
    const name = entry.name.slice(prefix.length + 1).toLowerCase();
    if (!label.test(name) || name === "default") continue;
    const dir = path.join(home, entry.name);
    if (extra && !extra.some((file) => fs.existsSync(path.join(dir, file)))) continue;
    out.push({ label: name, home: dir });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
};
const kill = (child) => {
  try {
    if (windows && child.pid) cp.spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else child.kill("SIGKILL");
  } catch {}
};
const envFor = (key, dir) => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(HERDR_|CLANKIE_|SWARM_)/.test(name)) delete env[name];
  if (dir === undefined) delete env[key]; else env[key] = dir;
  return env;
};
const run = (command, args, env, cwd) => new Promise((resolve) => {
  let out = "", done = false;
  const child = cp.spawn(command, args, { env, cwd, shell: windows, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  const finish = (value) => { if (done) return; done = true; clearTimeout(timer); kill(child); resolve(value); };
  const timer = setTimeout(() => finish(null), input.timeoutMs);
  child.stdout.on("data", (chunk) => { out += chunk; if (out.length > 65536) finish(null); });
  child.on("error", () => finish(null));
  child.on("close", () => finish(out));
});
const claudeUsage = async (env) => {
  const v = String(await run("claude", ["--version"], env)).split(".", 3);
  if (!(v[0] * 1e6 + v[1] * 1e3 + parseFloat(v[2]) >= input.claudeUsageVersion)) return {};
  let r = String(await run("claude", ["-p", "/usage", "--output-format", "json", "--no-session-persistence"], env, os.tmpdir()));
  try { r = JSON.parse(r.slice(r.indexOf("{"))); } catch {}
  return r.local_command == "usage" ? { usageLines: String(r.result).split("\n").filter((l) => l.startsWith("Current ")).slice(0, 8) } : {};
};
const claude = async (profile) => {
  const env = envFor("CLAUDE_CONFIG_DIR", profile.isDefault ? process.env.CLAUDE_CONFIG_DIR : profile.home);
  const raw = await run("claude", ["auth", "status", "--json"], env);
  let status = null;
  try { status = JSON.parse(String(raw).slice(String(raw).indexOf("{"))); } catch {}
  const usage = status && status.loggedIn === true ? await claudeUsage(env) : {};
  let c = null;
  try { c = JSON.parse(fs.readFileSync(path.join(profile.isDefault && !process.env.CLAUDE_CONFIG_DIR ? home : profile.home, ".claude.json"), "utf8")); } catch (e) { if (e.code == "ENOENT") c = {}; }
  const o = c && status && status.loggedIn && c.oauthAccount && c.oauthAccount.emailAddress == status.email ? c.oauthAccount : {};
  let plugin = false;
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(profile.home, "plugins", "installed_plugins.json"), "utf8"));
    plugin = Array.isArray(registry.plugins && registry.plugins["clankie-worker@clankie"]);
  } catch {}
  return {
    harness: "claude", label: profile.label, home: profile.home,
    signedIn: status && typeof status.loggedIn === "boolean" ? status.loggedIn : null,
    identity: status && status.loggedIn && typeof status.email === "string" ? status.email : undefined,
    plan: status && status.loggedIn && typeof status.subscriptionType === "string" ? status.subscriptionType : (status && status.loggedIn && typeof status.authMethod === "string" ? status.authMethod : undefined),
    workerPlugin: plugin,
    onboarded: c ? c.hasCompletedOnboarding === true : undefined, tier: o.organizationRateLimitTier,
    ...usage,
  };
};
const codex = (profile) => new Promise((resolve) => {
  const result = { harness: "codex", label: profile.label, home: profile.home, signedIn: null };
  let done = false, buffer = "";
  const child = cp.spawn("codex", ["app-server", "--listen", "stdio://"], { env: envFor("CODEX_HOME", profile.isDefault ? process.env.CODEX_HOME : profile.home), shell: windows, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  const finish = () => { if (done) return; done = true; clearTimeout(timer); try { child.stdin.end(); } catch {} setTimeout(() => kill(child), 500); resolve(result); };
  const timer = setTimeout(finish, input.timeoutMs);
  const send = (value) => { try { child.stdin.write(JSON.stringify(value) + "\n"); } catch {} };
  let pending = 2;
  child.on("error", finish);
  child.on("close", finish);
  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.id === 1) { send({ method: "initialized", params: {} }); send({ id: 2, method: "account/read", params: { refreshToken: false } }); send({ id: 3, method: "account/rateLimits/read", params: {} }); continue; }
      if (message.id === 2) {
        const account = message.result && message.result.account;
        result.signedIn = message.error ? null : Boolean(account);
        if (account && typeof account.email === "string") result.identity = account.email;
        if (account && typeof account.planType === "string") result.plan = account.planType;
        else if (account && typeof account.type === "string") result.plan = account.type;
        const routing = message.result && message.result.workspaceRouting;
        if (routing && typeof routing.chatgptAccountId === "string") result.chatgptAccountId = routing.chatgptAccountId;
        pending -= 1;
      } else if (message.id === 3) {
        if (message.error) {
          const text = String(message.error.message || "");
          const code = /\b(401|403)\b/.exec(text);
          result.usageError = code ? code[1] : "unavailable";
        } else {
          const all = message.result || {};
          const limits = (all.rateLimitsByLimitId && all.rateLimitsByLimitId.codex) || all.rateLimits;
          const window = (value) => value ? { used_percent: value.usedPercent, window_minutes: value.windowDurationMins, resets_at: value.resetsAt } : null;
          if (limits) {
            result.limits = { primary: window(limits.primary), secondary: window(limits.secondary), rate_limit_reached_type: limits.rateLimitReachedType || null };
          }
          result.scopedLimits = Object.entries(all.rateLimitsByLimitId || {}).filter(([id, v]) => id != "codex" && v).slice(0, 4).map(([id, v]) => ({ id, name: v.limitName, primary: window(v.primary) }));
          if (all.ordinaryUsageAllowed === false || (limits && limits.spendControlReached === true)) result.usageBlocked = true;
        }
        pending -= 1;
      }
      if (pending === 0) finish();
    }
  });
  send({ id: 1, method: "initialize", params: { clientInfo: { name: "clankie-accounts", version: "1" } } });
});
(async () => {
  const output = { schemaVersion: 1, accounts: [] };
  const listed = (harness) => input.profiles && input.profiles[harness] ? input.profiles[harness].map((entry) => ({ ...entry, isDefault: entry.label === "default" })) : undefined;
  if (input.harnesses.includes("claude")) {
    const profiles = listed("claude") || [{ label: "default", home: process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), isDefault: true }, ...dirs(".claude")];
    output.accounts.push(...(await Promise.all(profiles.map(claude))));
  }
  if (input.harnesses.includes("codex")) {
    const profiles = listed("codex") || [{ label: "default", home: process.env.CODEX_HOME || path.join(home, ".codex"), isDefault: true }, ...dirs(".codex", ["config.toml", "auth.json"])];
    output.accounts.push(...(await Promise.all(profiles.map(codex))));
  }
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
})().catch(() => { process.stderr.write("account probe failed\n"); process.exit(1); });
`
  .replace(/\n[ \t]*/gu, " ")
  // Windows carries it UTF-16 base64-encoded inside a bounded ssh command
  // line; no string in it has a space beside this punctuation.
  .replace(/ *([,;{}()=:?|&<>]) */gu, "$1");

const Window = z
  .object({
    used_percent: z.number().optional(),
    window_minutes: z.number().optional(),
    resets_at: z.number().nullable().optional(),
  })
  .nullable();
const ProbeOutput = z.object({
  schemaVersion: z.literal(1),
  accounts: z
    .array(
      z.object({
        harness: z.enum(["claude", "codex"]),
        label: z.string().regex(LABEL),
        home: z.string().min(1).max(4096),
        signedIn: z.boolean().nullable(),
        identity: z.string().max(320).optional(),
        plan: z.string().max(64).optional(),
        workerPlugin: z.boolean().optional(),
        onboarded: z.boolean().optional(),
        tier: z
          .string()
          .regex(/^[a-z0-9_]{1,64}$/u)
          .optional()
          .catch(undefined),
        chatgptAccountId: z.string().max(128).optional(),
        usageError: z.string().max(16).optional(),
        usageBlocked: z.boolean().optional(),
        usageLines: z.array(z.string().max(300)).max(8).optional(),
        scopedLimits: z
          .array(
            z.object({
              id: z.string().max(256),
              name: z.string().max(256).nullable().optional(),
              primary: Window,
            }),
          )
          .max(4)
          .optional(),
        limits: z
          .object({ primary: Window, secondary: Window, rate_limit_reached_type: z.unknown() })
          .optional(),
      }),
    )
    .max(64),
});
type ProbeAccount = z.infer<typeof ProbeOutput>["accounts"][number];

const PROBE_TIMEOUT_MS = 20_000;
const PROBE_OUTPUT_BYTES = 256 * 1024;

/** The probe command for one machine; runs its Node with the script as an argument. */
export function workerAccountsProbeCommand(
  shell: HerdrSshTransport["shell"],
  harnesses: readonly WorkerAccountHarness[] = WORKER_ACCOUNT_HARNESSES,
  /** Registered profiles instead of discovery (this Mac's own registry). */
  profiles?: Partial<Record<WorkerAccountHarness, readonly { label: string; home: string }[]>>,
): string {
  return remoteProgramCommand(shell, "node", [
    "-e",
    PROBE,
    JSON.stringify({
      harnesses,
      timeoutMs: PROBE_TIMEOUT_MS,
      claudeUsageVersion: CLAUDE_USAGE_MIN_VERSION_NUMBER,
      ...(profiles === undefined ? {} : { profiles }),
    }),
  ]);
}

/** This machine as a fleet shell, for its own registered profiles. */
const localWorkerAccountsShell: FleetShellRun = (command, timeoutMs) =>
  new Promise((resolve, reject) =>
    execFile(
      "/bin/sh",
      ["-c", command],
      { timeout: timeoutMs ?? 60_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => (error === null ? resolve(String(stdout)) : reject(error)),
    ),
  );

/** Ask a linked machine which worker accounts it has and what each can do now. */
export async function readMachineWorkerAccounts(
  fleet: Pick<HerdrFleet, "id" | "ssh">,
  shell: FleetShellRun,
  options: {
    readonly harnesses?: readonly WorkerAccountHarness[];
    readonly holds?: readonly WorkerAccountHold[];
    readonly profiles?: Partial<Record<WorkerAccountHarness, readonly { label: string; home: string }[]>>;
    readonly now?: number;
  } = {},
): Promise<MachineWorkerAccounts> {
  const harnesses = options.harnesses ?? WORKER_ACCOUNT_HARNESSES;
  const now = options.now ?? Date.now();
  let parsed: z.infer<typeof ProbeOutput>;
  try {
    const raw = await shell(
      workerAccountsProbeCommand(fleet.ssh.shell, harnesses, options.profiles),
      PROBE_TIMEOUT_MS + 20_000,
    );
    if (Buffer.byteLength(raw) > PROBE_OUTPUT_BYTES) throw new Error();
    parsed = ProbeOutput.parse(JSON.parse(raw.slice(raw.indexOf("{"))));
  } catch {
    // Shell failures may carry remote stderr; name the machine, never forward it.
    const reason = `${fleet.id} did not answer the account probe (is Node on its PATH and the machine linked?)`;
    return {
      machine: fleet.id,
      shell: fleet.ssh.shell,
      observedAt: new Date(now).toISOString(),
      accounts: [],
      unavailable: Object.fromEntries(harnesses.map((harness) => [harness, reason])),
    };
  }
  return {
    machine: fleet.id,
    shell: fleet.ssh.shell,
    observedAt: new Date(now).toISOString(),
    accounts: parsed.accounts.map((account) =>
      judgeWorkerAccount(fleet.id, fleet.ssh.shell, account, options.holds ?? [], now),
    ),
  };
}

function judgeWorkerAccount(
  machine: string,
  shell: HerdrSshTransport["shell"],
  account: ProbeAccount,
  holds: readonly WorkerAccountHold[],
  now: number,
): WorkerAccountStatus {
  let headroom: number | null = null;
  let resetsAt: string | undefined;
  let usage: AccountUsage | undefined;
  if (account.usageLines !== undefined || account.limits !== undefined) {
    const windows =
      account.harness === "claude"
        ? claudeUsageWindows(claudeUsageLines(account.usageLines ?? []), now)
        : codexUsageWindows(account.limits, account.scopedLimits);
    if (windows.length)
      usage = {
        source: account.harness === "claude" ? "claude-usage" : "codex-rate-limits",
        observedAt: new Date(now).toISOString(),
        windows,
      };
  }
  if (account.harness === "claude" && usage) {
    headroom = usageHeadroom(usage, now);
    if (headroom === 0) resetsAt = exhaustedUntil(usage, now);
  }
  if (account.harness === "codex" && account.limits) {
    const limits = codexRateLimit(JSON.stringify({ payload: { rate_limits: account.limits } }));
    headroom = codexStatusFromLimits(
      { label: account.label, home: account.home },
      limits,
      new Date(now).toISOString(),
      now,
    ).headroom;
    const resets = limits
      ? [limits.resets.five_hour, limits.resets.seven_day].filter((value): value is number => value !== null)
      : [];
    if (headroom === 0 && resets.length) resetsAt = new Date(Math.max(...resets) * 1000).toISOString();
  }
  if (account.usageBlocked) headroom = 0;
  const hold = holds.find(
    (entry) =>
      entry.machine === machine && entry.harness === account.harness && entry.label === account.label,
  );
  const fix = accountFix(
    machine,
    shell,
    account.harness,
    account.label,
    account.home,
    account.workerPlugin !== true,
  );
  let reason: string | undefined;
  if (account.signedIn === false) reason = `not signed in. ${fix}`;
  else if (account.signedIn === null) reason = `sign-in state unknown (its CLI did not answer). ${fix}`;
  else if (account.usageError === "401" || account.usageError === "403")
    reason = `its sign-in was refused when reading usage (expired, revoked or unpaid). ${fix}`;
  else if (headroom === 0)
    reason = `usage exhausted${resetsAt ? ` until ${resetsAt}` : ""}; choose another account or wait`;
  else if (account.harness === "claude" && account.onboarded === false)
    reason = `Claude's first-run setup (theme, security notes, folder trust) is unfinished in this profile, so a hire would stall at it. ${claudeSetupFix(machine, shell, account.label, account.home)}`;
  else if (account.harness === "claude" && account.workerPlugin === false)
    reason = `Clankie's worker plugin is not installed in this profile. Run clankie herdr prepare ${machine}`;
  return {
    harness: account.harness,
    label: account.label,
    home: account.home,
    signedIn: account.signedIn,
    ...(account.identity === undefined ? {} : { identity: account.identity }),
    ...(account.plan === undefined ? {} : { plan: account.plan }),
    ...(account.tier === undefined ? {} : { tier: account.tier }),
    headroom,
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(usage === undefined ? {} : { usage }),
    ...(account.workerPlugin === undefined ? {} : { workerPlugin: account.workerPlugin }),
    ...(account.chatgptAccountId === undefined ? {} : { chatgptAccountId: account.chatgptAccountId }),
    ...(hold === undefined ? {} : { held: hold.reason === undefined ? {} : { reason: hold.reason } }),
    usable: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
  };
}

/** Where a new profile goes: beside the machine's default home. */
function newProfileHome(report: MachineWorkerAccounts, harness: WorkerAccountHarness, label: string): string {
  const native = report.shell === "powershell" ? win32 : posix;
  const fallback = report.shell === "powershell" ? "%USERPROFILE%" : "~";
  const base = report.accounts.find((account) => account.label === "default")?.home;
  return native.join(base === undefined ? fallback : native.dirname(base), `.${harness}-${label}`);
}

/** Finishing Claude's first-run screens once, interactively, in that profile. */
function claudeSetupFix(
  machine: string,
  shell: HerdrSshTransport["shell"],
  label: string,
  home: string,
): string {
  const command =
    label === "default"
      ? "claude"
      : shell === "powershell"
        ? `$env:CLAUDE_CONFIG_DIR='${home.replaceAll("'", "''")}'; claude`
        : `CLAUDE_CONFIG_DIR='${home.replaceAll("'", "'\\''")}' claude`;
  return `Open it once on ${machine} with ${command}, pick a theme, accept the security notes and trust the folder you hire into, then quit.`;
}

/** The owner's one step to make a profile usable on its machine. */
function accountFix(
  machine: string,
  shell: HerdrSshTransport["shell"],
  harness: WorkerAccountHarness,
  label: string,
  home: string,
  /** Claude: whether the worker plugin still has to be installed in that profile. */
  prepare = true,
): string {
  const key = harness === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const login = harness === "claude" ? "claude auth login" : "codex login";
  const command =
    label === "default"
      ? login
      : shell === "powershell"
        ? `$env:${key}='${home.replaceAll("'", "''")}'; ${login}`
        : `${key}='${home.replaceAll("'", "'\\''")}' ${login}`;
  return `Sign it in on ${machine}: ${command}${harness === "claude" && prepare ? `, then clankie herdr prepare ${machine}` : ""}.`;
}

export type WorkerAccountChoice =
  | { readonly account: WorkerAccountStatus; readonly skipped: readonly string[]; readonly why: string }
  | { readonly refused: string };

/**
 * One account for a hire. An explicit label is used exactly or refused with
 * the reason and fix; nothing else is tried. Without one, the usable
 * accounts that the owner has not held compete by allocation rank
 * (`allocateAccounts`: spare capacity per day, plan-weighted; unknown usage
 * last). Skipped accounts are named with why.
 */
export function chooseWorkerAccount(
  machine: string,
  harness: WorkerAccountHarness,
  report: MachineWorkerAccounts,
  label?: string,
): WorkerAccountChoice {
  const accounts = report.accounts.filter((account) => account.harness === harness);
  const noun = harness === "claude" ? "Claude profile" : "Codex account";
  if (label !== undefined) {
    const selected = accounts.find((account) => account.label === label);
    if (!selected) {
      const unavailable = report.unavailable?.[harness];
      return {
        refused: unavailable
          ? `Cannot confirm ${noun} ${label} on ${machine}: ${unavailable}. No other account was tried.`
          : `${machine} has no ${noun} ${label} (it has: ${accounts.map((a) => a.label).join(", ") || "none"}). ` +
            `${accountFix(machine, report.shell, harness, label, newProfileHome(report, harness, label))} No other account was tried.`,
      };
    }
    if (!selected.usable)
      return {
        refused: `${noun} ${label} on ${machine} (${selected.home}${selected.identity ? `, ${selected.identity}` : ""}) cannot take this hire: ${selected.reason}. No other account was tried.`,
      };
    return { account: selected, skipped: [], why: `${label} was named for this hire` };
  }
  const skipped = accounts
    .filter((account) => !account.usable || account.held)
    .map((account) =>
      account.held
        ? `${account.label}: held by the owner${account.held.reason ? ` (${account.held.reason})` : ""}`
        : `${account.label}: ${account.reason}`,
    );
  const best = harness === "pi" || harness === "prime" ? undefined : rankedAccounts(report, harness)[0];
  const chosen =
    best === undefined
      ? accounts.find((account) => account.usable && !account.held)
      : accounts.find((account) => account.label === best.label);
  if (chosen)
    return {
      account: chosen,
      skipped,
      why: best === undefined ? `${chosen.label} is the only usable, unheld ${noun}` : best.reason,
    };
  const unavailable = report.unavailable?.[harness];
  return {
    refused: unavailable
      ? `No ${noun} on ${machine} could be checked: ${unavailable}.`
      : `No ${noun} on ${machine} can take a hire now${skipped.length ? `: ${skipped.join("; ")}` : ""}.`,
  };
}

/** An account whose usage was not observed counts as this much left. */
const UNOBSERVED_HEADROOM = 0.5;

type WorkerHarnessChoice =
  | { readonly harness: WorkerAccountHarness; readonly why: string }
  | { readonly refused: string };

/**
 * The fallback harness for a hire that names none at any layer (no request,
 * role or fleet harness). Clankie normally chooses per job; this runs only when
 * he passes nothing, and it never assumes a harness. Among the machine's
 * usable accounts the owner has not held: one harness with any is chosen; with
 * both, the one whose best-ranked account is not on pace to run out before
 * its reset, then the one with more of its tightest window left (Codex only
 * when strictly more), otherwise Claude. An account whose usage was not
 * observed counts as half left and not running out.
 * `allowed` narrows the candidates, for example to the family of a requested
 * model. No usable account refuses with each skipped account's reason.
 */
export function chooseWorkerHarness(
  machine: string,
  report: MachineWorkerAccounts,
  allowed: readonly WorkerAccountHarness[] = [...WORKER_ACCOUNT_HARNESSES, "pi"],
  label?: string,
): WorkerHarnessChoice {
  const best = new Map<WorkerAccountHarness, number>();
  const short = new Map<WorkerAccountHarness, boolean>();
  const allocation = report.allocation ?? allocateAccounts(report);
  const skipped: string[] = [];
  for (const account of report.accounts) {
    if (!allowed.includes(account.harness) || (label !== undefined && account.label !== label)) continue;
    if (!account.usable || account.held) {
      skipped.push(
        `${account.harness} ${account.label}: ${account.held ? `held by the owner${account.held.reason ? ` (${account.held.reason})` : ""}` : account.reason}`,
      );
      continue;
    }
    const headroom = account.headroom ?? UNOBSERVED_HEADROOM;
    const ranked = allocation.accounts.find(
      (entry) => entry.harness === account.harness && entry.label === account.label,
    );
    const runsShort =
      ranked?.sparePerDay !== undefined && ranked.sparePerDay !== null && ranked.sparePerDay < 0;
    const previous = best.get(account.harness);
    const previousShort = short.get(account.harness) ?? true;
    if (
      previous === undefined ||
      (previousShort && !runsShort) ||
      (previousShort === runsShort && headroom > previous)
    ) {
      best.set(account.harness, headroom);
      short.set(account.harness, runsShort);
    }
  }
  const codex = best.get("codex");
  const claude = best.get("claude");
  const codexShort = short.get("codex") === true;
  const claudeShort = short.get("claude") === true;
  const pace = (harness: "claude" | "codex") =>
    allocation.recommendations.find((entry) => entry.harness === harness)?.reason ?? "";
  if (codex !== undefined && claude !== undefined && codexShort !== claudeShort)
    return claudeShort
      ? {
          harness: "codex",
          why: `Claude's best account on ${machine} is on pace to run out before its reset (${pace("claude")})`,
        }
      : {
          harness: "claude",
          why: `Codex's best account on ${machine} is on pace to run out before its reset (${pace("codex")})`,
        };
  if (codex !== undefined && (claude === undefined || codex > claude))
    return {
      harness: "codex",
      why:
        claude === undefined
          ? `no usable, unheld Claude profile on ${machine}`
          : `a Codex account on ${machine} has ${Math.round(codex * 100)}% usage left, more than Claude's ${Math.round(claude * 100)}%`,
    };
  if (claude !== undefined)
    return {
      harness: "claude",
      why:
        codex === undefined
          ? `no usable, unheld Codex account on ${machine}`
          : `Codex's best account on ${machine} has ${Math.round(codex * 100)}% usage left, no more than Claude's ${Math.round(claude * 100)}%`,
    };
  if (best.has("pi")) return { harness: "pi", why: `a verified Pi profile on ${machine} can run the hire` };
  const unavailable = allowed
    .map((harness) => report.unavailable?.[harness])
    .filter((reason): reason is string => reason !== undefined);
  return {
    refused:
      `No usable ${allowed.join(" or ")} account on ${machine} to choose a harness from` +
      `${skipped.length ? `: ${skipped.join("; ")}` : unavailable.length ? `: ${unavailable.join("; ")}` : ""}. ` +
      "Pass harness (and account) for this hire.",
  };
}

/**
 * A machine's worker accounts as Clankie reads them: a linked machine answers
 * through its fleet link; this Mac (and its named local sessions) answers for
 * its registered profiles. Owner holds name a machine by its runtime
 * connection id or the machine that connection rides.
 */
export function createWorkerAccountsReader(options: {
  readonly settings: () => Promise<
    Pick<ClankieSettings, "claudeAccounts" | "codexAccounts" | "workerAccountHolds" | "execution">
  >;
  readonly localFleet?: (id: string) => boolean;
  readonly piStatus?: () => Promise<WorkerAccountStatus>;
  /** Prime Agent's providers on this Mac. */
  readonly primeStatus?: () => readonly WorkerAccountStatus[];
  readonly fleet: (id: string) => Promise<HerdrFleet | undefined>;
  readonly shell?: (fleet: HerdrFleet) => FleetShellRun;
}) {
  const readAccounts = async (
    fleetId?: string,
    harnesses?: readonly WorkerAccountHarness[],
  ): Promise<MachineWorkerAccounts> => {
    const current = await options.settings();
    const machine = fleetId ?? "local";
    const connection = current.execution.connections.find((entry) => entry.id === fleetId);
    const names = new Set([machine, ...(connection?.machine ? [connection.machine] : [])]);
    const holds = current.workerAccountHolds
      .filter((hold) => names.has(hold.machine))
      .map((hold) => ({ ...hold, machine }));
    const read = { holds, ...(harnesses === undefined ? {} : { harnesses }) };
    const local =
      fleetId === undefined ||
      options.localFleet?.(fleetId) === true ||
      (connection !== undefined && "socketPath" in connection && connection.socketPath !== undefined);
    if (local) {
      const report = await readMachineWorkerAccounts(
        { id: machine, ssh: { host: "localhost", shell: "posix" } },
        localWorkerAccountsShell,
        {
          ...read,
          profiles: {
            claude: [
              { label: "default", home: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude") },
              ...current.claudeAccounts,
            ],
            codex: codexAccounts(current),
          },
        },
      );
      const accounts = [...report.accounts];
      if ((harnesses === undefined || harnesses.includes("pi")) && options.piStatus) {
        const pi = await options.piStatus();
        const hold = holds.find((entry) => entry.harness === "pi" && entry.label === pi.label);
        accounts.push({
          ...pi,
          ...(hold === undefined ? {} : { held: hold.reason === undefined ? {} : { reason: hold.reason } }),
        });
      }
      if ((harnesses === undefined || harnesses.includes("prime")) && options.primeStatus) {
        for (const prime of options.primeStatus()) {
          // A ChatGPT sign-in Clankie also has as a Codex home shares that home's limits.
          const pool =
            prime.chatgptAccountId === undefined
              ? undefined
              : accounts.find(
                  (account) =>
                    account.harness === "codex" && account.chatgptAccountId === prime.chatgptAccountId,
                );
          accounts.push(
            pool === undefined
              ? prime
              : {
                  ...prime,
                  sharesLimitsWith: { harness: "codex", label: pool.label },
                  headroom: pool.headroom,
                  ...(pool.usage === undefined ? {} : { usage: pool.usage }),
                  ...(pool.resetsAt === undefined ? {} : { resetsAt: pool.resetsAt }),
                  reason: `draws from Codex account ${pool.label}'s limits`,
                },
          );
        }
      }
      return { ...report, accounts };
    }
    const fleet = await options.fleet(fleetId);
    if (fleet === undefined || options.shell === undefined)
      throw new Error(`${fleetId} is not a linked machine; list them with clankie machines`);
    return readMachineWorkerAccounts(fleet, options.shell(fleet), read);
  };
  return async (
    fleetId?: string,
    harnesses?: readonly WorkerAccountHarness[],
  ): Promise<MachineWorkerAccounts> => {
    const read = await readAccounts(fleetId, harnesses);
    const report = {
      ...read,
      accounts: read.accounts.map(({ chatgptAccountId: _id, ...account }) => account),
    };
    return { ...report, allocation: allocateAccounts(report) };
  };
}
