import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";
import type { AgentHostConfig, AgentSessionFile } from "./index.ts";
import { powershellTurnScript } from "./turn-powershell.ts";

export interface AgentTurnInput {
  harness: AgentSessionFile["harness"];
  sessionId: string;
  cwd: string;
  message: string;
  sessionPath?: string;
}
export interface AgentTurnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  termination?: "aborted" | "timeout" | "unknown";
}
/** Injection points for execution tests; production callers use the defaults. */
export interface TurnOptions {
  spawn?: typeof nodeSpawn;
  timeoutMs?: number;
}
const MAX_OUTPUT = 1024 * 1024;
const MAX_TIMEOUT = 10 * 60 * 1000;
const ABORT_GRACE = 15_000;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function timeout(options: TurnOptions) {
  const value = options.timeoutMs ?? MAX_TIMEOUT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT)
    throw new Error("Invalid agent turn timeout");
  return value;
}
function validate(input: AgentTurnInput, windows: boolean) {
  if (!["claude", "codex", "grok", "pi"].includes(input.harness))
    throw new Error("Unsupported agent harness");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.sessionId))
    throw new Error("Resume requires an exact session UUID");
  const absolute = windows ? win32.isAbsolute : isAbsolute;
  if (!absolute(input.cwd) || input.cwd.includes("\0"))
    throw new Error("Resume requires an absolute working directory");
  if (
    input.sessionPath !== undefined &&
    (!absolute(input.sessionPath) ||
      input.sessionPath.includes("\0") ||
      !input.sessionPath.endsWith(".jsonl"))
  )
    throw new Error("Invalid resume transcript path");
  if (!input.message.trim() || input.message.includes("\0") || Buffer.byteLength(input.message) > 32 * 1024)
    throw new Error("Agent message must contain 1..32768 UTF-8 bytes and no NUL");
}
/** Prompts go through stdin, or Grok's prompt file, never an option-like argument. */
export function agentTurnArgs(input: AgentTurnInput, promptPath: string): string[] {
  switch (input.harness) {
    case "claude":
      return ["-p", "--resume", input.sessionId];
    case "codex":
      return ["exec", "resume", "--skip-git-repo-check", input.sessionId, "-"];
    case "grok":
      return ["--resume", input.sessionId, "--prompt-file", promptPath];
    case "pi":
      return ["-p", "--session", input.sessionPath ?? input.sessionId];
  }
}

function launchEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== "CLAUDECODE" && !/^(?:HERDR_|SWARM_|CLANKIE_SWARM_)/.test(key),
    ),
  );
}

async function capture(
  command: string,
  args: string[],
  options: TurnOptions & {
    cwd?: string;
    input?: string;
    signal?: AbortSignal;
    deadline: number;
    cancel?: () => Promise<void>;
  },
): Promise<AgentTurnResult> {
  if (options.signal?.aborted) return { exitCode: null, stdout: "", stderr: "", termination: "aborted" };
  return new Promise((resolve) => {
    const child = (options.spawn ?? nodeSpawn)(command, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: launchEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0),
      stdoutTruncated = false,
      stderrTruncated = false;
    let termination: AgentTurnResult["termination"];
    let done = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already exited */
      }
    };
    const stop = (reason: "aborted" | "timeout") => {
      if (done || termination !== undefined) return;
      termination = reason;
      if (options.cancel) {
        void options.cancel().catch(() => undefined);
        grace = setTimeout(kill, ABORT_GRACE);
      } else kill();
    };
    const timer = setTimeout(() => stop("timeout"), options.deadline);
    const abort = () => stop("aborted");
    options.signal?.addEventListener("abort", abort, { once: true });
    const finish = (exitCode: number | null, error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      options.signal?.removeEventListener("abort", abort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      resolve({
        exitCode,
        stdout: stdout.toString("utf8") + (stdoutTruncated ? "\n[stdout truncated]" : ""),
        stderr:
          (stderrTruncated ? "[stderr truncated]\n" : "") +
          stderr.toString("utf8") +
          (error ? `\n${error.message}` : ""),
        ...(termination ? { termination } : {}),
      });
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > MAX_OUTPUT) stdoutTruncated = true;
      stdout = Buffer.concat([stdout, chunk]).subarray(-MAX_OUTPUT);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length + chunk.length > MAX_OUTPUT) stderrTruncated = true;
      stderr = Buffer.concat([stderr, chunk]).subarray(-MAX_OUTPUT);
    });
    child.once("error", (error) => finish(127, error));
    child.once("close", (code) => finish(code));
    // A daemonized child must not keep the supervisor's output pipes open forever.
    child.once("exit", (code) => {
      const drain = setTimeout(() => finish(code), 500);
      drain.unref();
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input ?? "");
    if (options.signal?.aborted) abort();
  });
}

export async function runLocalAgentTurn(
  input: AgentTurnInput,
  signal: AbortSignal | undefined,
  options: TurnOptions,
): Promise<AgentTurnResult> {
  validate(input, process.platform === "win32");
  const duration = timeout(options);
  if (signal?.aborted) return { exitCode: null, stdout: "", stderr: "", termination: "aborted" };
  if (process.platform === "win32") return supervisedTurn(undefined, input, signal, options);
  const directory = await mkdtemp(join(tmpdir(), "clankie-agent-turn-"));
  try {
    const prompt = join(directory, "prompt");
    if (input.harness === "grok") await writeFile(prompt, input.message, { mode: 0o600 });
    return await capture(input.harness, agentTurnArgs(input, prompt), {
      ...options,
      cwd: input.cwd,
      input: input.harness === "grok" ? "" : input.message,
      deadline: duration,
      ...(signal ? { signal } : {}),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function encodedPowerShell(script: string) {
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}
function sshArgs(config: AgentHostConfig, script: string) {
  return ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", config.ssh, script];
}
function posixTurnScript(input: AgentTurnInput, token: string, duration: number): string {
  const args = agentTurnArgs(input, "PROMPT_FILE")
    .map((arg) => (arg === "PROMPT_FILE" ? '"$dir/prompt"' : quote(arg)))
    .join(" ");
  return `set -u
umask 077
dir="\${TMPDIR:-/tmp}/clankie-agent-turn-${token}"
mkdir -p "$dir" || exit 125
cleanup() { rm -rf "$dir"; }
trap cleanup EXIT
receipt() { printf '\\nCLANKIE_RUN_${token}:%s:%s\\n' "$1" "$2" >&2; }
if [ -f "$dir/cancel" ]; then receipt 125 aborted; exit 0; fi
cd ${quote(input.cwd)} || { receipt 125 completed; exit 0; }
cat > "$dir/prompt" || { receipt 125 completed; exit 0; }
# Freeze before walking children so a normal worker cannot spawn during cleanup.
kill_tree() {
  if ! kill -STOP "$1" 2>/dev/null; then
    [ -z "$(ps -p "$1" -o pid=)" ] || : > "$dir/kill-failed"
    return 0
  fi
  children=$(ps -axo pid=,ppid= | awk -v parent="$1" '$2 == parent {print $1}')
  for child in $children; do kill_tree "$child"; done
  kill -KILL "$1" 2>/dev/null || : > "$dir/kill-failed"
}
${quote(input.harness)} ${args} < ${input.harness === "grok" ? "/dev/null" : '"$dir/prompt"'} &
worker=$!
start=$(date +%s)
reason=completed
while kill -0 "$worker" 2>/dev/null; do
  if [ -f "$dir/cancel" ]; then reason=aborted; kill_tree "$worker"; break; fi
  now=$(date +%s)
  if [ "$((now-start))" -ge ${Math.ceil(duration / 1000)} ]; then reason=timeout; kill_tree "$worker"; break; fi
  sleep 1
done
wait "$worker"
code=$?
[ ! -f "$dir/kill-failed" ] || reason=unknown
receipt "$code" "$reason"
exit 0`;
}
async function supervisedTurn(
  config: AgentHostConfig | undefined,
  input: AgentTurnInput,
  signal: AbortSignal | undefined,
  options: TurnOptions,
): Promise<AgentTurnResult> {
  const duration = timeout(options),
    token = randomUUID();
  const windows = config?.shell === "powershell" || (!config && process.platform === "win32");
  const script = windows
    ? powershellTurnScript(input, token, duration)
    : posixTurnScript(input, token, duration);
  const wrapped = windows ? encodedPowerShell(script) : `sh -c ${quote(script)}`;
  const cancelScript = windows
    ? `$ErrorActionPreference='Stop'; $d=Join-Path $env:TEMP 'clankie-agent-turn-${token}'; [void][IO.Directory]::CreateDirectory($d); [IO.File]::WriteAllText((Join-Path $d 'cancel'),'cancel')`
    : `umask 077; dir="\${TMPDIR:-/tmp}/clankie-agent-turn-${token}"; mkdir -p "$dir" && : > "$dir/cancel"`;
  const cancel = async () => {
    const cancelWrapped = windows ? encodedPowerShell(cancelScript) : `sh -c ${quote(cancelScript)}`;
    await capture(
      config ? "ssh" : "powershell.exe",
      config
        ? sshArgs(config, cancelWrapped)
        : [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(cancelScript, "utf16le").toString("base64"),
          ],
      { ...options, deadline: 10_000 },
    );
  };
  if (signal?.aborted) return { exitCode: null, stdout: "", stderr: "", termination: "aborted" };
  const result = await capture(
    config ? "ssh" : "powershell.exe",
    config
      ? sshArgs(config, wrapped)
      : [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
    { ...options, deadline: duration + 20_000, input: input.message, cancel, ...(signal ? { signal } : {}) },
  );
  const expression = new RegExp(
    `\\r?\\nCLANKIE_RUN_${token}:(-?\\d+):(completed|aborted|timeout|unknown)(?=\\r?\\n|$)`,
    "g",
  );
  // PowerShell can append progress after the receipt; choose the final nonce match.
  const receipt = [...result.stderr.matchAll(expression)].at(-1);
  if (!receipt) return { ...result, exitCode: null, termination: "unknown" };
  const reason = receipt[2];
  return {
    exitCode: reason === "completed" ? Number(receipt[1]) : null,
    stdout: result.stdout,
    stderr: result.stderr.slice(0, receipt.index) + result.stderr.slice(receipt.index + receipt[0].length),
    ...(reason === "completed" ? {} : { termination: reason as "aborted" | "timeout" | "unknown" }),
  };
}

export async function runSshAgentTurn(
  config: AgentHostConfig,
  input: AgentTurnInput,
  signal: AbortSignal | undefined,
  options: TurnOptions,
): Promise<AgentTurnResult> {
  validate(input, config.shell === "powershell");
  return supervisedTurn(config, input, signal, options);
}
