/**
 * Worker harness sign-in with each harness's own official login, run as the
 * body's user so its credentials land in the harness's own store. Only the
 * login link and code pass through here; they are never logged or persisted.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type {
  HarnessLoginResult,
  HarnessLoginsResponse,
  LoginHarness,
} from "@clankie/protocol/harness-logins";

type Session = Extract<HarnessLoginResult, { ok: true }>;
interface Job {
  view: Session;
  principal: string;
  child: ChildProcessWithoutNullStreams;
}

const COMMANDS: Record<LoginHarness, readonly string[]> = {
  // Subscription is Claude's default; the link's page shows a code to send back.
  claude: ["claude", "auth", "login", "--claudeai"],
  codex: ["codex", "login", "--device-auth"],
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
}

export class HarnessSignIns {
  private readonly jobs = new Map<string, Job>();
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

  async start(harness: LoginHarness, principal: string): Promise<HarnessLoginResult> {
    this.prune();
    if (
      [...this.jobs.values()].some((job) => ["pending", "needs_code", "verifying"].includes(job.view.state))
    )
      return { ok: false, error: "busy" };
    if (!(await this.signedIn(harness)).installed) return { ok: false, error: "not_installed" };
    const [command, ...args] = COMMANDS[harness];
    let child: ChildProcessWithoutNullStreams;
    const env: NodeJS.ProcessEnv = { ...this.options.env, BROWSER: "false", NO_COLOR: "1" };
    // The login signs in the subscription, not whatever key the environment carries.
    if (harness === "claude") delete env.ANTHROPIC_API_KEY;
    try {
      // Its own process group: the npm launchers wrap a native binary, and
      // ending the sign-in must end both.
      child = spawn(command!, args, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch {
      return { ok: false, error: "not_installed" };
    }
    const job: Job = {
      principal,
      child,
      view: {
        ok: true,
        sessionId: randomUUID(),
        harness,
        expiresAt: new Date(Date.now() + (this.options.timeoutMs ?? 15 * 60_000)).toISOString(),
        state: "pending",
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
      if (!["pending", "needs_code", "verifying"].includes(job.view.state)) return;
      job.view = { ...job.view, state: "verifying" };
      // Trust the harness's own status, not the exit code alone.
      const status = await this.signedIn(job.view.harness);
      const signedIn =
        exitCode === 0 &&
        status.signedIn &&
        (job.view.harness !== "claude" || status.method === "subscription");
      if (signedIn && job.view.harness === "claude") this.preferSubscription();
      this.end(job, signedIn ? "complete" : "failed");
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
  ): Promise<{ installed: boolean; signedIn: boolean; method?: string }> {
    // An env key makes Claude report `api_key` whatever else is signed in: ask without it.
    const result = await this.capture(
      harness === "claude" ? ["claude", "auth", "status", "--json"] : ["codex", "login", "status"],
      harness === "claude" ? ["ANTHROPIC_API_KEY"] : [],
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

  private capture(
    argv: readonly string[],
    without: readonly string[] = [],
  ): Promise<{ code: number | null; stdout: string } | undefined> {
    return new Promise((resolve) => {
      const [command, ...args] = argv;
      let stdout = "";
      let child: ReturnType<typeof spawn>;
      const env: NodeJS.ProcessEnv = { ...this.options.env, NO_COLOR: "1" };
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
  private preferSubscription(): void {
    const key = this.options.env.ANTHROPIC_API_KEY?.trim().slice(-20);
    if (!key) return;
    const path = join(this.options.env.HOME ?? "", ".claude.json");
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

  private end(job: Job, state: Session["state"]): void {
    job.view = {
      ok: true,
      sessionId: job.view.sessionId,
      harness: job.view.harness,
      expiresAt: job.view.expiresAt,
      state,
    };
    if (job.child.exitCode !== null || job.child.pid === undefined) return;
    try {
      process.kill(-job.child.pid, "SIGTERM");
    } catch {
      job.child.kill();
    }
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
