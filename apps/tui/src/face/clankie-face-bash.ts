/**
 * Inline `!` shell escape for the Clankie face: run a host shell command and
 * render its outcome as a transcript block. The face owns the bash-mode state,
 * Ctrl-C wiring, and status indicator; this module owns the two reusable,
 * testable pieces — the command runner and the result renderer.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { ClankieFaceAnsiTheme } from "./clankie-face-theme.ts";

export interface FaceBashResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface RunFaceBashOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Shell to run the command with. Defaults to `$SHELL`, then `/bin/zsh`. */
  shell?: string;
  timeoutMs?: number;
  maxOutput?: number;
  /** Called once the child spawns so the caller can wire Ctrl-C cancellation. */
  onSpawn?: (child: ChildProcess) => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 100_000;

/**
 * Run a host shell command for the inline `!` escape. Uses the user's `$SHELL`
 * (so their PATH/profile applies), capping captured output and killing the
 * command after a timeout. Never rejects: spawn failures resolve as a non-zero
 * result so the transcript always shows an outcome.
 */
export function runFaceBashCommand(command: string, options: RunFaceBashOptions): Promise<FaceBashResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = options.maxOutput ?? DEFAULT_MAX_OUTPUT;
  const shell =
    options.shell ??
    (process.env.SHELL !== undefined && process.env.SHELL.trim().length > 0 ? process.env.SHELL : "/bin/zsh");
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(shell, ["-c", command], { cwd: options.cwd, env: options.env });
    options.onSpawn?.(child);
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const append = (chunk: Buffer, channel: "out" | "err"): void => {
      const remaining = maxOutput - (stdout.length + stderr.length);
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const full = chunk.toString("utf8");
      const text = full.slice(0, remaining);
      if (text.length < full.length) truncated = true;
      if (channel === "out") stdout += text;
      else stderr += text;
    };
    child.stdout?.on("data", (chunk: Buffer) => append(chunk, "out"));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk, "err"));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut, truncated, durationMs: Date.now() - startedAt });
    };
    child.on("error", (error: Error) => {
      stderr += `${stderr.length > 0 ? "\n" : ""}${error.message}`;
      finish(127);
    });
    // A signal-killed process reports code=null; map it to the conventional
    // 128+signal exit so a timeout (SIGKILL) or Ctrl-C (SIGINT) is never a 0.
    child.on("close", (code, signal) => {
      if (code !== null) finish(code);
      else if (timedOut) finish(124);
      else if (signal === "SIGINT") finish(130);
      else if (signal === "SIGTERM") finish(143);
      else finish(137);
    });
  });
}

/** Render the `$ command` header, output, and exit/duration footer for a bash result. */
export function formatFaceBashResultLines(
  command: string,
  result: FaceBashResult,
  ansi: ClankieFaceAnsiTheme,
  width: number,
): string[] {
  const bodyWidth = Math.max(1, width - 2);
  const lines = [`${ansi.accent("$")} ${ansi.bold(command)}`];
  const pushBlock = (text: string, paint?: (line: string) => string): void => {
    for (const raw of text.replace(/\n+$/u, "").split(/\r?\n/u)) {
      if (raw.length === 0) {
        lines.push("");
        continue;
      }
      for (const wrapped of wrapTextWithAnsi(paint === undefined ? raw : paint(raw), bodyWidth)) {
        lines.push(`  ${truncateToWidth(wrapped, bodyWidth, "", true)}`);
      }
    }
  };
  const hasStdout = result.stdout.trim().length > 0;
  const hasStderr = result.stderr.trim().length > 0;
  if (hasStdout) pushBlock(result.stdout);
  if (hasStderr) pushBlock(result.stderr, ansi.danger);
  if (!hasStdout && !hasStderr) lines.push(`  ${ansi.dim("(no output)")}`);
  const ok = result.code === 0 && !result.timedOut;
  const duration =
    result.durationMs < 1000 ? `${result.durationMs}ms` : `${(result.durationMs / 1000).toFixed(1)}s`;
  const footer = [
    ok ? ansi.green("exit 0") : ansi.red(`exit ${result.code}`),
    ansi.dim(duration),
    ...(result.timedOut ? [ansi.yellow("timed out")] : []),
    ...(result.truncated ? [ansi.dim("output truncated")] : []),
  ].join(ansi.dim("  ·  "));
  lines.push(`  ${footer}`);
  return lines;
}

/** Transcript block for one inline `!` shell command and its captured output. */
export class ClankieBashResultComponent implements Component {
  private readonly command: string;
  private readonly result: FaceBashResult;
  private readonly ansi: ClankieFaceAnsiTheme;

  constructor(command: string, result: FaceBashResult, ansi: ClankieFaceAnsiTheme) {
    this.command = command;
    this.result = result;
    this.ansi = ansi;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return formatFaceBashResultLines(this.command, this.result, this.ansi, width);
  }
}
