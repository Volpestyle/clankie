/**
 * Inline `!` shell escape for the Clankie face: run a host shell command and
 * stream its output into the shell's bash transcript block. The face owns the
 * bash-mode state, Ctrl-C wiring, and rendering; this module owns the
 * reusable, testable command runner.
 */
import { type ChildProcess, spawn } from "node:child_process";

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
  /** Streams captured output (stdout and stderr interleaved) as it arrives. */
  onOutput?: (chunk: string) => void;
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
      if (text.length > 0) options.onOutput?.(text);
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
      const message = `${stderr.length > 0 ? "\n" : ""}${error.message}`;
      stderr += message;
      options.onOutput?.(message);
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
