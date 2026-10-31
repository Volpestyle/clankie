/**
 * Worker harness sign-in with each harness's own official login, run as the
 * body's user so its credentials land in the harness's own store. Only the
 * login link and code pass through here; they are never logged or persisted.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { realClaude } from "../../../integrations/herdr-plugin/claude-path-shim.mjs";
import type { MachineWorkerAccounts, WorkerAccountStatus } from "./captain/harness-accounts.ts";
import type {
  HarnessAccountLoginResult,
  HarnessLoginAccount,
  HarnessLoginAccountsResponse,
  HarnessLoginRemoveResult,
  HarnessLoginResult,
  HarnessLoginsResponse,
  LoginHarness,
} from "@clankie/protocol/harness-logins";

type Session = Extract<HarnessLoginResult, { ok: true }>;
type Failure = Extract<HarnessAccountLoginResult, { ok: false }>;
interface Job {
  view: Session;
  principal: string;
  child: ChildProcessWithoutNullStreams;
  /** The environment the login ran in; its status is read the same way. */
  env: NodeJS.ProcessEnv;
  /** A named profile: its identity before, and whether this sign-in created its home. */
  target?: {
    readonly label: string;
    readonly home: string;
    readonly before?: string;
    readonly created: boolean;
  };
}
/** One profile home as the account reader sees it. */
interface Profile {
  readonly label: string;
  readonly home: string;
  /** The harness's default home or its standard `~/.claude` / `~/.codex`: never removed. */
  readonly protected: boolean;
  readonly identity?: string;
  /** Other names a signed-out profile answers to. */
  readonly aliases: readonly string[];
}

const HOME_VARIABLE: Record<LoginHarness, "CLAUDE_CONFIG_DIR" | "CODEX_HOME"> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
};
/** Marks a profile home Clankie created, so removing it may delete it. */
const MANAGED_MARKER = ".clankie-profile";

const COMMANDS: Record<LoginHarness, readonly string[]> = {
  // Subscription is Claude's default; the link's page shows a code to send back.
  claude: ["auth", "login", "--claudeai"],
  codex: ["login", "--device-auth"],
};
/** Only the vendor's own sign-in pages are forwarded to a device. */
const LOGIN_HOSTS: Record<LoginHarness, readonly string[]> = {
  claude: ["claude.com", "claude.ai", "platform.claude.com", "console.anthropic.com"],
  codex: ["auth.openai.com"],
};

export interface HarnessSignInOptions {
  readonly env: NodeJS.ProcessEnv;
  /** Device codes last 15 minutes; the session ends with them. */
  readonly timeoutMs?: number;
  /**
   * This Mac's Claude and Codex accounts from the shared identity-keyed reader
   * (VUH-2145). Without it only the default home can be signed in.
   */
  readonly accounts?: () => Promise<MachineWorkerAccounts>;
  /** Moves a re-signed profile's labels to the identity now signed in there. */
  readonly rebind?: (harness: LoginHarness, labels: readonly string[], accountKey: string) => void;
}

export class HarnessSignIns {
  private readonly jobs = new Map<string, Job>();
  /** A start or remove between its busy check and its job: the next one is busy too. */
  private reserved = false;
  private readonly options: HarnessSignInOptions;
  constructor(options: HarnessSignInOptions) {
    this.options = options;
  }

  /** Secret-free status from each harness's own status command. */
  async list(): Promise<HarnessLoginsResponse> {
    const harnesses = await Promise.all(
      (["claude", "codex"] as const).map(async (harness) => ({ harness, ...(await this.signedIn(harness)) })),
    );
    return { harnesses };
  }

  /** Every account per harness, one row per signed-in identity plus each signed-out profile. */
  async accounts(): Promise<HarnessLoginAccountsResponse> {
    if (!this.options.accounts) throw new Error("Worker accounts are unavailable");
    const report = await this.options.accounts();
    return {
      harnesses: (["claude", "codex"] as const).map((harness) => {
        const accounts = report.accounts
          .filter((account) => account.harness === harness)
          .map((account) => this.row(harness, account))
          // The default home first, then signed-in accounts, as the reader ordered them.
          .sort((a, b) => Number(b.default) - Number(a.default) || Number(b.signedIn) - Number(a.signedIn));
        return {
          harness,
          installed: report.unavailable?.[harness] === undefined || accounts.length > 0,
          accounts,
        };
      }),
    };
  }

  /**
   * Sign a harness in. Without `profile` or `add` this is the default home,
   * as shipped apps ask. `profile` re-signs exactly that profile's home;
   * `add` creates a fresh `~/.claude-<label>` or `~/.codex-<label>` and never
   * resolves to a home that already exists.
   */
  async start(
    harness: LoginHarness,
    principal: string,
    target: { readonly profile?: string; readonly add?: { readonly label?: string } } = {},
  ): Promise<HarnessAccountLoginResult> {
    this.prune();
    if (this.busy()) return { ok: false, error: "busy" };
    this.reserved = true;
    try {
      return await this.begin(harness, principal, target);
    } finally {
      this.reserved = false;
    }
  }

  private async begin(
    harness: LoginHarness,
    principal: string,
    target: { readonly profile?: string; readonly add?: { readonly label?: string } },
  ): Promise<HarnessAccountLoginResult> {
    const command = await this.executable(harness);
    if (!command || !(await this.signedIn(harness)).installed) return { ok: false, error: "not_installed" };
    const env: NodeJS.ProcessEnv = { ...this.options.env, BROWSER: "false", NO_COLOR: "1" };
    // The login signs in the subscription, not whatever key the environment carries.
    if (harness === "claude") delete env.ANTHROPIC_API_KEY;
    let profile: Job["target"];
    if (target.add !== undefined) {
      const created = await this.create(harness, target.add.label);
      if ("error" in created) return created;
      profile = { ...created, created: true };
    } else if (target.profile !== undefined) {
      const found = await this.find(harness, target.profile);
      if ("error" in found) return found;
      profile = {
        label: found.label,
        home: found.home,
        ...(found.identity === undefined ? {} : { before: found.identity }),
        created: false,
      };
    }
    // The default keeps this service's own environment, exactly as the reader probes it.
    if (profile !== undefined && profile.label !== "default") this.useHome(env, harness, profile.home);
    let child: ChildProcessWithoutNullStreams;
    try {
      // Its own process group: the npm launchers wrap a native binary, and
      // ending the sign-in must end both.
      child = spawn(command, COMMANDS[harness], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch {
      if (profile?.created) rmSync(profile.home, { recursive: true, force: true });
      return { ok: false, error: "not_installed" };
    }
    const job: Job = {
      principal,
      child,
      env,
      ...(profile === undefined ? {} : { target: profile }),
      view: {
        ok: true,
        sessionId: randomUUID(),
        harness,
        expiresAt: new Date(Date.now() + (this.options.timeoutMs ?? 15 * 60_000)).toISOString(),
        state: "pending",
        ...(profile === undefined ? {} : { profile: profile.label }),
      },
    };
    this.jobs.set(job.view.sessionId, job);
    this.run(job);
    return { ...job.view };
  }

  status(sessionId: string, principal: string, cancel = false): HarnessLoginResult {
    this.prune();
    const job = this.jobs.get(sessionId);
    if (!job || job.principal !== principal) return { ok: false, error: "session_not_found" };
    if (cancel && ["pending", "needs_code"].includes(job.view.state)) this.end(job, "cancelled");
    return { ...job.view };
  }

  code(sessionId: string, principal: string, code: string): HarnessLoginResult {
    this.prune();
    const job = this.jobs.get(sessionId);
    if (!job || job.principal !== principal) return { ok: false, error: "session_not_found" };
    if (job.view.harness !== "claude" || job.view.state !== "needs_code")
      return { ok: false, error: "malformed" };
    const { codeRejected: _rejected, ...view } = job.view;
    job.view = { ...view, state: "verifying" };
    job.child.stdin.write(`${code.trim()}\n`);
    return { ...job.view };
  }

  /**
   * Sign one profile out with its harness's own logout. A profile Clankie
   * created is then deleted; any other stays, signed out. The default and
   * standard homes are never removed: re-sign them instead.
   */
  async remove(harness: LoginHarness, label: string): Promise<HarnessLoginRemoveResult> {
    if (label === "default") return { ok: false, error: "default_profile" };
    this.prune();
    if (this.busy()) return { ok: false, error: "busy" };
    this.reserved = true;
    try {
      const found = await this.find(harness, label);
      if ("error" in found) return found;
      if (found.protected) return { ok: false, error: "default_profile" };
      const command = await this.executable(harness);
      if (!command) return { ok: false, error: "not_installed" };
      const env = this.useHome({ ...this.options.env }, harness, found.home);
      await this.capture(harness === "claude" ? [command, "auth", "logout"] : [command, "logout"], [], env);
      // Deleting or reporting success needs the harness's own conclusive
      // signed-out answer; a failed, empty or unreadable status keeps the home.
      if (!(await this.signedOut(harness, command, env))) return { ok: false, error: "unavailable" };
      const deleted = existsSync(join(found.home, MANAGED_MARKER));
      if (deleted) rmSync(found.home, { recursive: true, force: true });
      return { ok: true, harness, profile: found.label, deleted };
    } finally {
      this.reserved = false;
    }
  }

  close(): void {
    for (const job of this.jobs.values())
      if (["pending", "needs_code", "verifying"].includes(job.view.state)) this.end(job, "cancelled");
  }

  private run(job: Job): void {
    const timer = setTimeout(
      () => {
        if (["pending", "needs_code", "verifying"].includes(job.view.state)) this.end(job, "expired");
      },
      Math.max(1, Date.parse(job.view.expiresAt) - Date.now()),
    );
    timer.unref();
    let output = "";
    const read = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-16_384);
      if (job.view.state === "verifying" && job.view.harness === "claude") {
        // Claude keeps waiting after a wrong code: let the owner send another.
        if (/Invalid code/u.test(chunk.toString("utf8")))
          job.view = { ...job.view, state: "needs_code", codeRejected: true };
        return;
      }
      if (job.view.url !== undefined || job.view.state !== "pending") return;
      const text = stripVTControlCharacters(output);
      const url = this.loginUrl(job.view.harness, text);
      if (url === undefined) return;
      if (job.view.harness === "codex") {
        // The one-time code follows the link: `XXXX-XXXXX`.
        const userCode = /\b([A-Z0-9]{4}-[A-Z0-9]{4,8})\b/u.exec(
          text.slice(text.indexOf(url) + url.length),
        )?.[1];
        if (userCode === undefined) return;
        job.view = { ...job.view, url, userCode };
      } else job.view = { ...job.view, url, state: "needs_code" };
    };
    job.child.stdout.on("data", read);
    job.child.stderr.on("data", read);
    job.child.on("error", () => {
      if (["pending", "needs_code", "verifying"].includes(job.view.state)) this.end(job, "failed");
    });
    job.child.on("close", async (exitCode) => {
      clearTimeout(timer);
      if (!["pending", "needs_code", "verifying"].includes(job.view.state)) {
        this.discard(job);
        return;
      }
      job.view = { ...job.view, state: "verifying" };
      // Trust the harness's own status, not the exit code alone.
      const status = await this.signedIn(job.view.harness, job.env);
      const signedIn =
        exitCode === 0 &&
        status.signedIn &&
        (job.view.harness !== "claude" || status.method === "subscription");
      if (signedIn && job.view.harness === "claude") this.preferSubscription(job.env);
      if (!signedIn) {
        this.end(job, "failed");
        this.discard(job);
        return;
      }
      const outcome = job.target === undefined ? {} : await this.outcome(job.view.harness, job.target);
      this.end(job, "complete", outcome);
    });
  }

  private loginUrl(harness: LoginHarness, text: string): string | undefined {
    for (const match of text.matchAll(/https:\/\/[^\s"'<>]+/gu)) {
      try {
        const url = new URL(match[0]);
        if (url.username || url.password) continue;
        if (LOGIN_HOSTS[harness].includes(url.hostname)) return url.toString();
      } catch {
        // Not a URL; keep looking.
      }
    }
    return undefined;
  }

  private async signedIn(
    harness: LoginHarness,
    env: NodeJS.ProcessEnv = this.options.env,
  ): Promise<{ installed: boolean; signedIn: boolean; method?: string }> {
    const command = await this.executable(harness);
    if (!command) return { installed: false, signedIn: false };
    // An env key makes Claude report `api_key` whatever else is signed in: ask without it.
    const result = await this.capture(
      harness === "claude" ? [command, "auth", "status", "--json"] : [command, "login", "status"],
      harness === "claude" ? ["ANTHROPIC_API_KEY"] : [],
      env,
    );
    if (result === undefined) return { installed: false, signedIn: false };
    if (harness === "claude") {
      let subscription = false;
      try {
        subscription = (JSON.parse(result.stdout) as { loggedIn?: unknown }).loggedIn === true;
      } catch {
        // Unreadable status: not signed in.
      }
      if (subscription) return { installed: true, signedIn: true, method: "subscription" };
      return this.options.env.ANTHROPIC_API_KEY?.trim()
        ? { installed: true, signedIn: true, method: "api_key" }
        : { installed: true, signedIn: false };
    }
    const method = /Logged in using (.+)/u.exec(result.stdout)?.[1]?.trim().slice(0, 64);
    return {
      installed: true,
      signedIn: result.code === 0,
      ...(result.code === 0 && method ? { method } : {}),
    };
  }

  /**
   * Only the harness's explicit signed-out answer counts: Claude's status JSON
   * with `loggedIn: false`, or Codex's failing `Not logged in`. Claude is asked
   * without an `ANTHROPIC_API_KEY`, which is not this home's to clear.
   */
  private async signedOut(harness: LoginHarness, command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
    if (harness === "codex") {
      const result = await this.capture([command, "login", "status"], [], env);
      return result !== undefined && result.code !== 0 && /^Not logged in\b/mu.test(result.stdout);
    }
    const result = await this.capture([command, "auth", "status", "--json"], ["ANTHROPIC_API_KEY"], env);
    if (result === undefined) return false;
    try {
      return (
        (JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as { loggedIn?: unknown }).loggedIn ===
        false
      );
    } catch {
      return false;
    }
  }

  /** Clankie's own `claude` PATH shim is not Claude Code: look past it. */
  private async executable(harness: LoginHarness): Promise<string | undefined> {
    if (harness === "codex") return "codex";
    // allow-swallowed-rejection -- realClaude rejects only when no real Claude is on PATH: not installed.
    return realClaude(this.options.env).catch(() => undefined);
  }

  private capture(
    argv: readonly string[],
    without: readonly string[] = [],
    base: NodeJS.ProcessEnv = this.options.env,
  ): Promise<{ code: number | null; stdout: string } | undefined> {
    return new Promise((resolve) => {
      const [command, ...args] = argv;
      let stdout = "";
      let child: ReturnType<typeof spawn>;
      const env: NodeJS.ProcessEnv = { ...base, NO_COLOR: "1" };
      for (const name of without) delete env[name];
      try {
        child = spawn(command!, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        resolve(undefined);
        return;
      }
      const timer = setTimeout(() => child.kill(), 15_000);
      child.stdout?.on(
        "data",
        (chunk: Buffer) => (stdout = `${stdout}${chunk.toString("utf8")}`.slice(-65_536)),
      );
      child.stderr?.on(
        "data",
        (chunk: Buffer) => (stdout = `${stdout}${chunk.toString("utf8")}`.slice(-65_536)),
      );
      child.on("error", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout });
      });
    });
  }

  /**
   * A subscription login wins over an `ANTHROPIC_API_KEY` in the environment:
   * Claude records the owner's choice by the key's last 20 characters.
   */
  private preferSubscription(env: NodeJS.ProcessEnv): void {
    const key = this.options.env.ANTHROPIC_API_KEY?.trim().slice(-20);
    if (!key) return;
    // A profile keeps its state in its own config directory.
    const path = join(env.CLAUDE_CONFIG_DIR ?? env.HOME ?? "", ".claude.json");
    try {
      const state = JSON.parse(readFileSync(path, "utf8")) as {
        customApiKeyResponses?: { approved?: string[]; rejected?: string[] };
      };
      const responses = state.customApiKeyResponses ?? {};
      state.customApiKeyResponses = {
        ...responses,
        approved: (responses.approved ?? []).filter((entry) => entry !== key),
        rejected: [...(responses.rejected ?? []).filter((entry) => entry !== key), key],
      };
      writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
    } catch {
      // No Claude state yet: Claude will ask, and the subscription is already signed in.
    }
  }

  private end(
    job: Job,
    state: Session["state"],
    outcome: Pick<Session, "identityChanged" | "duplicateOf"> = {},
  ): void {
    job.view = {
      ok: true,
      sessionId: job.view.sessionId,
      harness: job.view.harness,
      expiresAt: job.view.expiresAt,
      state,
      ...(job.view.profile === undefined ? {} : { profile: job.view.profile }),
      ...outcome,
    };
    if (job.child.exitCode !== null || job.child.pid === undefined) return;
    try {
      process.kill(-job.child.pid, "SIGTERM");
    } catch {
      job.child.kill();
    }
  }

  private busy(): boolean {
    return (
      this.reserved ||
      [...this.jobs.values()].some((job) => ["pending", "needs_code", "verifying"].includes(job.view.state))
    );
  }

  /** A home this sign-in created and did not finish signing in goes, once its login has exited. */
  private discard(job: Job): void {
    if (job.target?.created && job.view.state !== "complete")
      rmSync(job.target.home, { recursive: true, force: true });
  }

  /**
   * Point a named profile's harness at its home: the standard home with the
   * variable unset, as the reader probes it (Claude keys its keychain entry by
   * that variable, VUH-2241), any other explicitly.
   */
  private useHome(env: NodeJS.ProcessEnv, harness: LoginHarness, home: string): NodeJS.ProcessEnv {
    if (home === this.standard(harness)) delete env[HOME_VARIABLE[harness]];
    else env[HOME_VARIABLE[harness]] = home;
    return env;
  }

  private standard(harness: LoginHarness): string {
    return this.canonical(join(this.options.env.HOME ?? "", `.${harness}`));
  }

  private canonical(path: string): string {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  }

  private async profiles(harness: LoginHarness): Promise<Profile[] | Failure> {
    if (!this.options.accounts) return { ok: false, error: "unavailable" };
    const report = await this.options.accounts();
    if (report.unavailable?.[harness] !== undefined && !report.accounts.some((a) => a.harness === harness))
      return { ok: false, error: "unavailable" };
    const standard = this.standard(harness);
    return report.accounts
      .filter((account) => account.harness === harness)
      .flatMap((account) =>
        // A signed-in identity lists its homes; a signed-out profile is its own.
        (account.homes ?? [{ label: account.label, home: account.home }]).map((entry) => {
          const aliases = account.homes === undefined ? (account.aliases ?? []) : [];
          return {
            label: entry.label,
            home: entry.home,
            protected: entry.label === "default" || entry.home === standard || aliases.includes("default"),
            ...(account.identity === undefined ? {} : { identity: account.identity }),
            aliases,
          };
        }),
      );
  }

  private async find(harness: LoginHarness, label: string): Promise<Profile | Failure> {
    const profiles = await this.profiles(harness);
    if (!Array.isArray(profiles)) return profiles;
    const found =
      profiles.find((profile) => profile.label === label) ??
      profiles.find((profile) => profile.aliases.includes(label));
    return found ?? { ok: false, error: "profile_not_found" };
  }

  /** A fresh home beside the standard one; refuses any label or path already in use. */
  private async create(
    harness: LoginHarness,
    requested: string | undefined,
  ): Promise<{ label: string; home: string } | Failure> {
    if (requested === "default") return { ok: false, error: "profile_exists" };
    const profiles = await this.profiles(harness);
    if (!Array.isArray(profiles)) return profiles;
    const taken = new Set(profiles.flatMap((profile) => [profile.label, ...profile.aliases]));
    const homes = new Set(profiles.map((profile) => profile.home));
    const base = this.options.env.HOME;
    if (!base) return { ok: false, error: "unavailable" };
    const at = (label: string) => join(base, `.${harness}-${label}`);
    let label = requested;
    for (let n = 2; label === undefined && n < 100; n += 1)
      if (!taken.has(`account-${n}`) && !existsSync(at(`account-${n}`))) label = `account-${n}`;
    if (label === undefined || taken.has(label)) return { ok: false, error: "profile_exists" };
    const home = at(label);
    try {
      // Not recursive: an existing directory fails here instead of being reused.
      mkdirSync(home, { mode: 0o700 });
    } catch {
      return { ok: false, error: "profile_exists" };
    }
    const canonical = this.canonical(home);
    if (homes.has(canonical)) {
      rmSync(home, { recursive: true, force: true });
      return { ok: false, error: "profile_exists" };
    }
    writeFileSync(
      join(canonical, MANAGED_MARKER),
      `${JSON.stringify({ harness, createdAt: new Date().toISOString() })}\n`,
      {
        mode: 0o600,
      },
    );
    // The account reader finds Codex homes by their config file.
    if (harness === "codex") writeFileSync(join(canonical, "config.toml"), "", { mode: 0o600 });
    return { label, home: canonical };
  }

  /** What the finished sign-in did to its profile, from the same reader the fleet hires by. */
  private async outcome(
    harness: LoginHarness,
    target: NonNullable<Job["target"]>,
  ): Promise<Pick<Session, "identityChanged" | "duplicateOf">> {
    try {
      const report = await this.options.accounts!();
      const account = report.accounts.find(
        (entry) =>
          entry.harness === harness &&
          (entry.homes ?? [{ label: entry.label, home: entry.home }]).some(
            (home) => home.home === target.home,
          ),
      );
      if (account === undefined) return {};
      const others = (account.homes ?? []).filter((home) => home.home !== target.home);
      // The owner signed this profile in on purpose: hires naming it reach the
      // account verified there now, whatever it held or lacked before.
      if (account.accountKey !== undefined) {
        const labels = (account.homes ?? [])
          .filter((home) => home.home === target.home)
          .map((home) => home.label);
        this.options.rebind?.(harness, [...new Set([target.label, ...labels])], account.accountKey);
      }
      if (target.created) return others[0] === undefined ? {} : { duplicateOf: others[0].label };
      if (target.before !== undefined && account.identity !== target.before) {
        return {
          identityChanged: {
            before: target.before,
            ...(account.identity === undefined ? {} : { after: account.identity }),
          },
        };
      }
    } catch {
      // The sign-in itself completed; its comparison is best effort.
    }
    return {};
  }

  private row(harness: LoginHarness, account: WorkerAccountStatus): HarnessLoginAccount {
    const homes = account.homes ?? [{ label: account.label, home: account.home }];
    const standard = this.standard(harness);
    return {
      profile: homes[0]!.label,
      profiles: homes.map((home) => home.label),
      default:
        homes.some((home) => home.label === "default" || home.home === standard) ||
        (account.homes === undefined && (account.aliases ?? []).includes("default")),
      // Removing the row deletes it only when Clankie created every home it is signed in under.
      managed: homes.every((home) => existsSync(join(home.home, MANAGED_MARKER))),
      signedIn: account.signedIn,
      ...(account.identity === undefined ? {} : { identity: account.identity }),
      ...(account.plan === undefined ? {} : { plan: account.plan }),
      headroom: account.headroom === null ? null : Math.min(1, Math.max(0, account.headroom)),
      ...(account.resetsAt === undefined ? {} : { resetsAt: account.resetsAt }),
      ready: account.usable,
      ...(account.held === undefined ? {} : { held: true as const }),
    };
  }

  private prune(): void {
    for (const [id, job] of this.jobs) {
      if (Date.parse(job.view.expiresAt) <= Date.now() && ["pending", "needs_code"].includes(job.view.state))
        this.end(job, "expired");
      if (
        !["pending", "needs_code", "verifying"].includes(job.view.state) &&
        Date.parse(job.view.expiresAt) + 300_000 <= Date.now()
      )
        this.jobs.delete(id);
    }
  }
}
