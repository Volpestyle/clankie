import { execFile, spawn, type ChildProcess, type ExecFileException } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { HerdrSshTransport } from "@clankie/settings";
import { decodeRemoteShellError } from "./remote-shell-error.ts";

/**
 * A Herdr fleet on another machine (ADR 0184): its CLI runs there, over the
 * owner's own ssh, one argv at a time. Nothing here can start, stop or replace
 * the remote server: only read and pane verbs pass, and `--session` names a
 * server that must already be running (the CLI reports `server_not_running`
 * rather than starting one).
 */
export interface HerdrFleet {
  readonly id: string;
  readonly session: string;
  readonly ssh: HerdrSshTransport;
}

/** `<fleet>/<pane or terminal id>`; the local default fleet keeps bare ids (ADR 0184). */
const FLEET_QUALIFIED = /^([a-z][a-z0-9-]{0,63})\/(.+)$/u;

export function fleetQualified(fleet: string, id: string): string {
  return `${fleet}/${id}`;
}

export function splitFleetQualified(
  value: string,
): { readonly fleet: string; readonly id: string } | undefined {
  const match = FLEET_QUALIFIED.exec(value);
  return match === null ? undefined : { fleet: match[1]!, id: match[2]! };
}

/**
 * The verbs a remote fleet answers. Anything that launches, attaches, stops,
 * updates or reconfigures a server is absent, so a typo or a model-chosen
 * argument cannot replace the owner's desktop-session Herdr.
 */
const REMOTE_VERBS: Readonly<Record<string, ReadonlySet<string> | true>> = {
  agent: new Set(["list", "get", "read", "wait", "prompt", "send-keys", "start"]),
  // `report-agent` labels a pane whose seat Clankie drives over its native
  // channel; it updates Herdr's view and controls nothing.
  pane: new Set([
    "list",
    "get",
    "read",
    "send-text",
    "send-keys",
    "close",
    "process-info",
    "layout",
    "split",
    "report-agent",
    "report-metadata",
    "rename",
  ]),
  tab: new Set(["create", "list", "rename"]),
  workspace: new Set(["create", "list", "report-metadata"]),
  worktree: new Set(["list"]),
  api: new Set(["snapshot"]),
  session: new Set(["list"]),
};

export function assertRemoteHerdrArgs(args: readonly string[]): void {
  const [verb, sub] = args;
  const allowed = verb === undefined ? undefined : REMOTE_VERBS[verb];
  if (allowed === undefined || (allowed !== true && (sub === undefined || !allowed.has(sub))))
    throw new Error(`herdr ${[verb, sub].filter(Boolean).join(" ")} is not available on a remote fleet`);
  if (args.some((arg) => arg.includes("\0"))) throw new Error("Herdr arguments cannot contain NUL");
}

const posixQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** One argument as `CommandLineToArgvW` (and Rust's std) will read it back. */
export function windowsArgument(value: string): string {
  if (value !== "" && !/[\s"]/u.test(value)) return value;
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    quoted +=
      character === '"' ? `${"\\".repeat(backslashes * 2 + 1)}"` : `${"\\".repeat(backslashes)}${character}`;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

/**
 * The remote command for one Herdr call, with the session named on every call.
 */
export function remoteHerdrCommand(fleet: HerdrFleet, args: readonly string[]): string {
  assertRemoteHerdrArgs(args);
  return remoteProgramCommand(fleet.ssh.shell, "herdr", ["--session", fleet.session, ...args]);
}

/**
 * One program with an exact argv on the remote shell. PowerShell never parses
 * the arguments: they travel as one base64 command line handed to
 * `ProcessStartInfo`, the child inherits stdin, and its stdout and stderr bytes
 * are copied through unchanged, so JSON, NDJSON and UTF-8 survive Windows
 * PowerShell 5.1's native-argument and output re-encoding rules.
 */
export function remoteProgramCommand(
  shell: HerdrSshTransport["shell"],
  program: string,
  argv: readonly string[],
  /** Run it in this directory on the remote machine; the remote user's home when absent. */
  cwd?: string,
): string {
  if (!/^[a-z][a-z0-9-]*$/u.test(program)) throw new Error("Remote program must be a bare command name");
  if (argv.some((arg) => arg.includes("\0")) || cwd?.includes("\0") === true)
    throw new Error("Remote arguments cannot contain NUL");
  // Only the bootstrap knows whether the child started. A command-specific
  // marker prevents an application's own dependency error from replaying it.
  const launchFailure = `clankie-launch-${randomBytes(8).toString("hex")}: `;
  if (shell === "posix")
    return posixScriptCommand(
      [
        ...(cwd === undefined
          ? []
          : [
              `cd ${posixQuote(cwd)} || { printf '%s\\n' ${posixQuote(`${launchFailure}Cannot enter working directory ${cwd}`)} >&2; exit 127; }`,
            ]),
        `command -v ${program} >/dev/null 2>&1 || { printf '%s\\n' ${posixQuote(`${launchFailure}${program} not found in PATH`)} >&2; exit 127; }`,
        `exec ${program} ${argv.map(posixQuote).join(" ")}`,
      ].join("; "),
    );
  const commandLine = Buffer.from(argv.map(windowsArgument).join(" "), "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    `$program = (Get-Command ${program} -CommandType Application | Select-Object -First 1).Source`,
    "$start = New-Object System.Diagnostics.ProcessStartInfo",
    "$start.FileName = $program",
    `$start.Arguments = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${commandLine}'))`,
    ...(cwd === undefined ? [] : [`$start.WorkingDirectory = ${powershellLiteral(cwd)}`]),
    "$start.UseShellExecute = $false",
    "$start.RedirectStandardOutput = $true",
    "$start.RedirectStandardError = $true",
    "$child = [System.Diagnostics.Process]::Start($start)",
    `} catch { [Console]::Error.WriteLine(${powershellLiteral(launchFailure)} + $_.Exception.Message); exit 127 }`,
    "$errors = $child.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())",
    "$out = [Console]::OpenStandardOutput()",
    "$child.StandardOutput.BaseStream.CopyTo($out)",
    "$out.Flush()",
    "$errors.Wait()",
    "$child.WaitForExit()",
    "exit $child.ExitCode",
  ].join("; ");
  return powershellScriptCommand(script);
}

/** A PowerShell single-quoted literal: nothing inside it is interpolated. */
export function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Windows PowerShell 5.1 writes stdout in the console's code page, which turns
 * UTF-8 text such as an em dash into bytes that can include a `"` and break
 * JSON; it also emits progress records as CLIXML. Every script starts by
 * writing UTF-8 and staying quiet.
 */
const POWERSHELL_PREAMBLE =
  "$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false; $OutputEncoding = [Console]::OutputEncoding";

/** A whole PowerShell script as one remote command, never re-parsed by an outer shell. */
export function powershellScriptCommand(script: string): string {
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(`${POWERSHELL_PREAMBLE}; ${script}`, "utf16le").toString("base64")}`;
}

/** A POSIX shell script as one remote command, whatever the login shell is. */
export function posixScriptCommand(script: string): string {
  return `exec sh -c ${posixQuote(script)}`;
}

export { posixQuote };

/**
 * One multiplexed ssh connection per fleet carries every call (ADR 0184). The
 * control socket lives under his state directory. Each service lifetime has
 * its own short generation, so it never inherits an old login environment.
 * Retired masters keep existing clients and expire when idle; nothing closes
 * the owner's other SSH sessions.
 */
export const SSH_CONTROL_MAX_AGE_MS = 10 * 60 * 1_000;

const controlConnections = new Map<string, { path: string; since: number }>();

function controlConnectionKey(fleet: HerdrFleet, controlDirectory: string): string {
  return JSON.stringify([controlDirectory, fleet.id, fleet.ssh.host]);
}

function controlPath(fleet: HerdrFleet, directory: string, maxAgeMs: number): string {
  const key = controlConnectionKey(fleet, directory);
  const current = controlConnections.get(key);
  if (current && Date.now() - current.since < maxAgeMs) return current.path;
  const path = join(directory, `${randomBytes(3).toString("hex")}-%C`);
  controlConnections.set(key, { path, since: Date.now() });
  return path;
}

function retireControlConnection(fleet: HerdrFleet, directory: string, usedArgs: readonly string[]): void {
  const key = controlConnectionKey(fleet, directory);
  const current = controlConnections.get(key);
  // Concurrent failures retire the same generation only once.
  if (current && usedArgs.includes(`ControlPath=${current.path}`)) controlConnections.delete(key);
}

export function sshArgs(
  fleet: HerdrFleet,
  controlDirectory: string,
  remoteCommand: string,
  maxControlAgeMs = SSH_CONTROL_MAX_AGE_MS,
): string[] {
  return [
    ...SSH_BASE_OPTIONS,
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${controlPath(fleet, controlDirectory, maxControlAgeMs)}`,
    "-o",
    "ControlPersist=600",
    "--",
    fleet.ssh.host,
    remoteCommand,
  ];
}

export const SSH_BASE_OPTIONS: readonly string[] = [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
];

class HerdrFleetError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "HerdrFleetError";
    this.code = code;
  }
}

/** Herdr answers errors as JSON on stdout; a transport failure has none. */
function herdrError(stdout: string): HerdrFleetError | undefined {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { error?: { code?: unknown; message?: unknown } };
      if (parsed.error !== undefined)
        return new HerdrFleetError(
          typeof parsed.error.code === "string" ? parsed.error.code : "herdr_error",
          typeof parsed.error.message === "string" ? parsed.error.message : "Herdr reported an error",
        );
    } catch {
      // Not a Herdr envelope.
    }
  }
  return undefined;
}

/**
 * One remote command (already built for the fleet's shell) over the fleet's
 * multiplexed connection; resolves its stdout. Used for the few non-Herdr
 * steps a native channel needs on that machine, such as starting a dedicated
 * Codex app-server (VUH-1527).
 */
export type FleetShellRun = (remoteCommand: string, timeoutMs?: number) => Promise<string>;

interface FleetCommandOptions {
  readonly controlDirectory: string;
  readonly execFile?: typeof execFile;
  readonly maxControlAgeMs?: number;
}

function launchFailureMarker(command: string): string | undefined {
  const encoded = /-EncodedCommand (\S+)$/u.exec(command)?.[1];
  const script = encoded ? Buffer.from(encoded, "base64").toString("utf16le") : command;
  return /clankie-launch-[a-f0-9]{16}: /u.exec(script)?.[0];
}

/** Retry only launcher/environment failures that occurred before the program ran. */
async function runFleetCommand(
  fleet: HerdrFleet,
  options: FleetCommandOptions,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  mkdirSync(options.controlDirectory, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  const launchMarker = launchFailureMarker(command);
  for (let attempt = 0; ; attempt += 1) {
    const args = sshArgs(fleet, options.controlDirectory, command, options.maxControlAgeMs);
    const result = await new Promise<{
      error: ExecFileException | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      (options.execFile ?? execFile)(
        "ssh",
        args,
        {
          maxBuffer: 8 * 1024 * 1024,
          timeout: Math.max(1, deadline - Date.now()),
          ...(signal === undefined ? {} : { signal }),
        },
        (error, stdout, stderr) => resolve({ error, stdout: String(stdout), stderr: String(stderr) }),
      );
    });
    if (
      attempt === 0 &&
      result.error !== null &&
      !result.error.killed &&
      !signal?.aborted &&
      herdrError(result.stdout) === undefined &&
      result.error.code === 127 &&
      launchMarker !== undefined &&
      result.stderr.includes(launchMarker) &&
      Date.now() < deadline
    ) {
      retireControlConnection(fleet, options.controlDirectory, args);
      continue;
    }
    return { ...result, stderr: decodeRemoteShellError(result.stderr) };
  }
}

export function createFleetShellRun(fleet: HerdrFleet, options: FleetCommandOptions): FleetShellRun {
  return async (remoteCommand, timeoutMs = REMOTE_HERDR_TIMEOUT_MS) => {
    const { error, stdout, stderr } = await runFleetCommand(fleet, options, remoteCommand, timeoutMs);
    if (error === null) return stdout;
    throw new HerdrFleetError(
      error.killed ? "timeout" : "fleet_command_failed",
      `fleet ${fleet.id}: ${stderr.slice(0, 2_000) || error.message}`,
    );
  };
}

export type HerdrFleetRun = (
  args: readonly string[],
  signal?: AbortSignal,
  timeoutMs?: number,
) => Promise<string>;

const REMOTE_HERDR_TIMEOUT_MS = 20_000;

export function createHerdrFleetRun(fleet: HerdrFleet, options: FleetCommandOptions): HerdrFleetRun {
  return async (args, signal, timeoutMs = REMOTE_HERDR_TIMEOUT_MS) => {
    const command = remoteHerdrCommand(fleet, args);
    const { error, stdout, stderr } = await runFleetCommand(fleet, options, command, timeoutMs, signal);
    const reported = herdrError(stdout);
    if (reported !== undefined) throw reported;
    if (error !== null) {
      if (signal?.aborted === true) throw error;
      throw new HerdrFleetError(
        error.killed ? "timeout" : "fleet_unreachable",
        error.killed
          ? `fleet ${fleet.id}: herdr ${args.slice(0, 2).join(" ")} timed out after ${String(timeoutMs)} ms`
          : `fleet ${fleet.id}: ${stderr || error.message}`,
      );
    }
    return stdout;
  };
}

/** A service-authored streaming command over the same fleet SSH multiplexer. */
export function createFleetShellStream(
  fleet: HerdrFleet,
  options: {
    readonly controlDirectory: string;
    readonly spawn?: typeof spawn;
    readonly maxControlAgeMs?: number;
  },
): (remoteCommand: string) => ChildProcess {
  return (remoteCommand) => {
    mkdirSync(options.controlDirectory, { recursive: true, mode: 0o700 });
    return (options.spawn ?? spawn)(
      "ssh",
      sshArgs(fleet, options.controlDirectory, remoteCommand, options.maxControlAgeMs),
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  };
}

export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("No local port was assigned")),
      );
    });
  });
}

/** The forward's own ssh connection: it must end exactly when this seat's link does. */
export function forwardSshArgs(fleet: HerdrFleet, localPort: number, remotePort: number): string[] {
  return [
    ...SSH_BASE_OPTIONS,
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ExitOnForwardFailure=yes",
    "-N",
    "-L",
    `127.0.0.1:${String(localPort)}:127.0.0.1:${String(remotePort)}`,
    "--",
    fleet.ssh.host,
  ];
}
