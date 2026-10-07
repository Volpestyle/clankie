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
 * (`claude auth status`, Codex's app-server `account/read` and
 * `account/rateLimits/read`) and returns identity, plan and usage only. It
 * never reads, prints or moves a credential, and never starts a login or turn.
 *
 * Profiles are the machine's default home plus every `~/.claude-<label>` and
 * `~/.codex-<label>` directory, the same convention `clankie herdr prepare`
 * uses to install the worker plugin into each Claude profile.
 */

export type WorkerAccountHarness = "claude" | "codex";
const WORKER_ACCOUNT_HARNESSES: readonly WorkerAccountHarness[] = ["claude", "codex"];

interface WorkerAccountStatus {
  readonly harness: WorkerAccountHarness;
  readonly label: string;
  /** The profile home on its own machine. */
  readonly home: string;
  readonly signedIn: boolean | null;
  /** The account's email as its CLI reports it; never a token. */
  readonly identity?: string;
  readonly plan?: string;
  /** Codex: lowest remaining fraction of its usage windows; null when unobservable (always for Claude). */
  readonly headroom: number | null;
  readonly resetsAt?: string;
  /** Claude: whether Clankie's worker plugin is installed in this profile. */
  readonly workerPlugin?: boolean;
  /** The owner set this account aside from automatic choice. */
  readonly held?: { readonly reason?: string };
  /** Whether Clankie would hire on it now, and why not. */
  readonly usable: boolean;
  readonly reason?: string;
}

export interface MachineWorkerAccounts {
  readonly machine: string;
  readonly shell: HerdrSshTransport["shell"];
  readonly observedAt: string;
  readonly accounts: readonly WorkerAccountStatus[];
  /** A harness the machine could not answer for, with why. */
  readonly unavailable?: Partial<Record<WorkerAccountHarness, string>>;
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
const run = (command, args, env) => new Promise((resolve) => {
  let out = "", done = false;
  const child = cp.spawn(command, args, { env, shell: windows, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  const finish = (value) => { if (done) return; done = true; clearTimeout(timer); kill(child); resolve(value); };
  const timer = setTimeout(() => finish(null), input.timeoutMs);
  child.stdout.on("data", (chunk) => { out += chunk; if (out.length > 65536) finish(null); });
  child.on("error", () => finish(null));
  child.on("close", () => finish(out));
});
const claude = async (profile) => {
  const raw = await run("claude", ["auth", "status", "--json"], envFor("CLAUDE_CONFIG_DIR", profile.isDefault ? process.env.CLAUDE_CONFIG_DIR : profile.home));
  let status = null;
  try { status = JSON.parse(String(raw).slice(String(raw).indexOf("{"))); } catch {}
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
        pending -= 1;
      } else if (message.id === 3) {
        if (message.error) {
          const text = String(message.error.message || "");
          const code = /\b(401|403)\b/.exec(text);
          result.usageError = code ? code[1] : "unavailable";
        } else {
          const all = message.result || {};
          const limits = (all.rateLimitsByLimitId && all.rateLimitsByLimitId.codex) || all.rateLimits;
          if (limits) {
            const window = (value) => value ? { used_percent: value.usedPercent, window_minutes: value.windowDurationMins, resets_at: value.resetsAt } : null;
            result.limits = { primary: window(limits.primary), secondary: window(limits.secondary), rate_limit_reached_type: limits.rateLimitReachedType || null };
          }
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
`.replace(/\n[ \t]*/gu, " ");

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
        usageError: z.string().max(16).optional(),
        usageBlocked: z.boolean().optional(),
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
  else if (account.harness === "claude" && account.workerPlugin === false)
    reason = `Clankie's worker plugin is not installed in this profile. Run clankie herdr prepare ${machine}`;
  return {
    harness: account.harness,
    label: account.label,
    home: account.home,
    signedIn: account.signedIn,
    ...(account.identity === undefined ? {} : { identity: account.identity }),
    ...(account.plan === undefined ? {} : { plan: account.plan }),
    headroom,
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(account.workerPlugin === undefined ? {} : { workerPlugin: account.workerPlugin }),
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
  | { readonly account: WorkerAccountStatus; readonly skipped: readonly string[] }
  | { readonly refused: string };

/**
 * One account for a hire. An explicit label is used exactly or refused with
 * the reason and fix; nothing else is tried. Without one, the usable
 * accounts that the owner has not held compete: known headroom first, then
 * unknown, in the machine's order. Skipped accounts are named with why.
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
    return { account: selected, skipped: [] };
  }
  const skipped = accounts
    .filter((account) => !account.usable || account.held)
    .map((account) =>
      account.held
        ? `${account.label}: held by the owner${account.held.reason ? ` (${account.held.reason})` : ""}`
        : `${account.label}: ${account.reason}`,
    );
  const rank = (headroom: number | null) => (headroom === null ? 1 : 2);
  const candidates = accounts
    .filter((account) => account.usable && !account.held)
    .map((account, index) => ({ account, index }))
    .sort(
      (a, b) =>
        rank(b.account.headroom) - rank(a.account.headroom) ||
        (b.account.headroom ?? 0) - (a.account.headroom ?? 0) ||
        a.index - b.index,
    );
  const chosen = candidates[0]?.account;
  if (chosen) return { account: chosen, skipped };
  const unavailable = report.unavailable?.[harness];
  return {
    refused: unavailable
      ? `No ${noun} on ${machine} could be checked: ${unavailable}.`
      : `No ${noun} on ${machine} can take a hire now${skipped.length ? `: ${skipped.join("; ")}` : ""}.`,
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
  readonly fleet: (id: string) => Promise<HerdrFleet | undefined>;
  readonly shell?: (fleet: HerdrFleet) => FleetShellRun;
}) {
  return async (
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
    if (local)
      return readMachineWorkerAccounts(
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
    const fleet = await options.fleet(fleetId);
    if (fleet === undefined || options.shell === undefined)
      throw new Error(`${fleetId} is not a linked machine; list them with clankie machines`);
    return readMachineWorkerAccounts(fleet, options.shell(fleet), read);
  };
}
