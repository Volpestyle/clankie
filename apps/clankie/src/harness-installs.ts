/**
 * Install a worker harness with its vendor's own installer (#737), as the
 * body's user, so the owner's app can offer one Install button in place of a
 * line to paste into Terminal. One install runs at a time; once it exits, the
 * sign-in list is read again and decides the outcome.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type {
  HarnessInstall,
  HarnessInstallResult,
  HarnessLoginsResponse,
  LoginHarness,
} from "@clankie/protocol/harness-logins";

/** The vendor's documented install line, and how this service runs it. */
export interface VendorInstaller {
  readonly line: string;
  readonly command: string;
  readonly args: readonly string[];
}

const PROGRESS_LINES = 40;
const LINE_CHARACTERS = 500;
/** After the timeout's SIGTERM, how long the installer's group has before SIGKILL. */
const KILL_GRACE_MS = 5_000;
/** After the installer exits, how long a grandchild holding its output may delay the outcome. */
const DRAIN_MS = 2_000;

async function onPath(name: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    try {
      await access(join(directory, name), constants.X_OK);
      return true;
    } catch {
      /* Not in this PATH entry. */
    }
  }
  return false;
}

/**
 * Claude Code's native installer, and Codex through Homebrew on a Mac that has
 * it, else npm: the lines core already tells owners to paste.
 */
export async function vendorInstaller(
  harness: LoginHarness,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<VendorInstaller | undefined> {
  if (harness === "claude") {
    if (platform === "win32") {
      if (!(await onPath("powershell.exe", env))) return undefined;
      const line = "irm https://claude.ai/install.ps1 | iex";
      return { line, command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", line] };
    }
    if (!(await onPath("curl", env))) return undefined;
    const line = "curl -fsSL https://claude.ai/install.sh | bash";
    return { line, command: "/bin/bash", args: ["-o", "pipefail", "-c", line] };
  }
  if (platform === "darwin" && (await onPath("brew", env)))
    return { line: "brew install --cask codex", command: "brew", args: ["install", "--cask", "codex"] };
  const line = "npm install -g @openai/codex";
  if (platform === "win32")
    return (await onPath("npm.cmd", env))
      ? { line, command: "cmd.exe", args: ["/d", "/s", "/c", line] }
      : undefined;
  return (await onPath("npm", env))
    ? { line, command: "npm", args: ["install", "-g", "@openai/codex"] }
    : undefined;
}

export interface HarnessInstallOptions {
  readonly env: NodeJS.ProcessEnv;
  /** The sign-in list, read before (already installed?) and after (did it land?). */
  readonly logins: { list(): Promise<HarnessLoginsResponse> };
  /** Which installer runs; tests stand one in so no vendor install ever runs. */
  readonly installer?: (harness: LoginHarness) => Promise<VendorInstaller | undefined>;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

export class HarnessInstalls {
  private latest: { view: HarnessInstall; child?: ChildProcess } | undefined;
  /** A start between its busy check and its spawn: the next one is busy too. */
  private reserved = false;
  private readonly options: HarnessInstallOptions;
  constructor(options: HarnessInstallOptions) {
    this.options = options;
  }

  current(): HarnessInstallResult {
    return this.latest ? { ok: true, install: this.snapshot() } : { ok: false, error: "install_not_found" };
  }

  async start(
    harness: LoginHarness,
    ownerApproval: "claimed" | "not_claimed",
  ): Promise<HarnessInstallResult> {
    if (this.reserved || this.latest?.view.state === "running")
      return this.latest?.view.state === "running"
        ? { ok: false, error: "busy", install: this.snapshot() }
        : { ok: false, error: "busy" };
    this.reserved = true;
    try {
      const before = await this.options.logins.list();
      if (before.harnesses.find((entry) => entry.harness === harness)?.installed)
        return { ok: false, error: "already_installed" };
      const installer = await (this.options.installer ?? ((name) => this.vendor(name)))(harness);
      if (!installer) return { ok: false, error: "installer_unavailable" };
      this.run(harness, installer, ownerApproval);
      return { ok: true, install: this.snapshot() };
    } finally {
      this.reserved = false;
    }
  }

  /** The real vendor installer, never under the test runner: a test must stand one in (#737). */
  private async vendor(harness: LoginHarness): Promise<VendorInstaller | undefined> {
    if (process.env.VITEST !== undefined)
      throw new Error("Under test, a stand-in installer must replace the vendor's; none ran");
    return vendorInstaller(harness, this.options.env);
  }

  close(): void {
    const child = this.latest?.child;
    if (child?.pid !== undefined && child.exitCode === null) stop(child);
  }

  private snapshot(): HarnessInstall {
    const view = this.latest!.view;
    return { ...view, progress: [...view.progress] };
  }

  private run(harness: LoginHarness, installer: VendorInstaller, ownerApproval: "claimed" | "not_claimed") {
    const now = this.options.now ?? (() => new Date());
    const view: HarnessInstall = {
      installId: randomUUID(),
      harness,
      installer: installer.line,
      state: "running",
      startedAt: now().toISOString(),
      progress: [],
      ownerApproval,
    };
    const entry: { view: HarnessInstall; child?: ChildProcess } = { view };
    this.latest = entry;
    let partial = "";
    const take = (text: string, flush = false) => {
      const lines = `${partial}${text}`.split(/\r\n|\r|\n/u);
      partial = flush ? "" : lines.pop()!;
      // Output with no line break still lands, a line's worth at a time.
      if (partial.length > LINE_CHARACTERS) {
        lines.push(partial);
        partial = "";
      }
      for (const raw of lines) {
        const line = stripVTControlCharacters(raw)
          // oxlint-disable-next-line no-control-regex -- control characters never reach the app or a terminal.
          .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "")
          .trim()
          .slice(0, LINE_CHARACTERS);
        if (line) view.progress.push(line);
      }
      view.progress.splice(0, Math.max(0, view.progress.length - PROGRESS_LINES));
    };
    let timedOut = false;
    let child: ChildProcess;
    try {
      child = spawn(installer.command, [...installer.args], {
        env: { ...this.options.env, NONINTERACTIVE: "1", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group, so a timeout also stops what the installer started.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      take(`Could not start the installer: ${error instanceof Error ? error.message : String(error)}\n`);
      void this.finish(view, harness, null, false);
      return;
    }
    entry.child = child;
    // Decoded per stream, so a character split across chunks stays whole.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (text: string) => take(text));
    child.stderr?.on("data", (text: string) => take(text));
    const timer = setTimeout(
      () => {
        timedOut = true;
        stop(child);
      },
      this.options.timeoutMs ?? 15 * 60_000,
    );
    timer.unref?.();
    let settled = false;
    const settle = (code: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) take(`Could not start the installer: ${error.message}\n`);
      take("", true);
      void this.finish(view, harness, code, timedOut);
    };
    child.on("error", (error) => settle(null, error));
    child.on("close", (code) => settle(code));
    // A grandchild still holding the installer's output must not keep the install running forever.
    child.on("exit", (code) => setTimeout(() => settle(code), DRAIN_MS).unref?.());
  }

  private async finish(view: HarnessInstall, harness: LoginHarness, code: number | null, timedOut: boolean) {
    // allow-swallowed-rejection -- an unreadable sign-in list leaves the install unproven, so it fails below.
    const logins = await this.options.logins.list().catch(() => undefined);
    const installed = logins?.harnesses.find((entry) => entry.harness === harness)?.installed === true;
    const now = this.options.now ?? (() => new Date());
    Object.assign(view, {
      finishedAt: now().toISOString(),
      exitCode: code,
      ...(logins ? { logins } : {}),
      ...(code === 0 && installed && !timedOut
        ? { state: "succeeded" }
        : {
            state: "failed",
            error: timedOut ? "timed_out" : code === 0 ? "not_found_after_install" : "installer_failed",
          }),
    });
  }
}

/** SIGTERM to the installer's whole group, then SIGKILL to whatever ignored it. */
function stop(child: ChildProcess) {
  const signal = (name: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, name);
      else child.kill(name);
    } catch {
      // The group is already gone; the leader alone may remain.
      child.kill(name);
    }
  };
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS).unref?.();
}
