import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HerdrSshTransport } from "@clankie/settings";

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
    "report-agent",
  ]),
  tab: new Set(["create", "list"]),
  workspace: new Set(["create", "list"]),
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
  if (shell === "posix")
    return `${cwd === undefined ? "" : `cd ${posixQuote(cwd)} && `}exec ${program} ${argv.map(posixQuote).join(" ")}`;
  const commandLine = Buffer.from(argv.map(windowsArgument).join(" "), "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$program = (Get-Command ${program} -CommandType Application | Select-Object -First 1).Source`,
    "$start = New-Object System.Diagnostics.ProcessStartInfo",
    "$start.FileName = $program",
    `$start.Arguments = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${commandLine}'))`,
    ...(cwd === undefined ? [] : [`$start.WorkingDirectory = ${powershellLiteral(cwd)}`]),
    "$start.UseShellExecute = $false",
    "$start.RedirectStandardOutput = $true",
    "$start.RedirectStandardError = $true",
    "$child = [System.Diagnostics.Process]::Start($start)",
    "$errors = $child.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())",
    "$out = [Console]::OpenStandardOutput()",
    "$child.StandardOutput.BaseStream.CopyTo($out)",
    "$out.Flush()",
    "$errors.Wait()",
    "$child.WaitForExit()",
    "exit $child.ExitCode",
  ].join("; ");
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

/** A PowerShell single-quoted literal: nothing inside it is interpolated. */
export function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A whole PowerShell script as one remote command, never re-parsed by an outer shell. */
export function powershellScriptCommand(script: string): string {
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

/** A POSIX shell script as one remote command, whatever the login shell is. */
export function posixScriptCommand(script: string): string {
  return `exec sh -c ${posixQuote(script)}`;
}

export { posixQuote };

/**
 * One multiplexed ssh connection per fleet carries every call (ADR 0184). The
 * control socket lives under his state directory, keyed by ssh's own `%C`
 * hash so it stays inside the 104-byte socket limit.
 */
export function sshArgs(fleet: HerdrFleet, controlDirectory: string, remoteCommand: string): string[] {
  return [
    ...SSH_BASE_OPTIONS,
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${join(controlDirectory, "%C")}`,
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

export function createFleetShellRun(
  fleet: HerdrFleet,
  options: {
    readonly controlDirectory: string;
    readonly execFile?: typeof execFile;
  },
): FleetShellRun {
  const run = options.execFile ?? execFile;
  return (remoteCommand, timeoutMs = REMOTE_HERDR_TIMEOUT_MS) => {
    try {
      mkdirSync(options.controlDirectory, { recursive: true, mode: 0o700 });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return new Promise((resolve, reject) => {
      run(
        "ssh",
        sshArgs(fleet, options.controlDirectory, remoteCommand),
        { maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs },
        (error, stdout, stderr) => {
          if (error === null) return resolve(String(stdout));
          const detail = String(stderr).trim().slice(-2_000);
          reject(
            new HerdrFleetError(
              error.killed ? "timeout" : "fleet_command_failed",
              `fleet ${fleet.id}: ${detail || error.message}`,
            ),
          );
        },
      );
    });
  };
}

export type HerdrFleetRun = (
  args: readonly string[],
  signal?: AbortSignal,
  timeoutMs?: number,
) => Promise<string>;

const REMOTE_HERDR_TIMEOUT_MS = 20_000;

export function createHerdrFleetRun(
  fleet: HerdrFleet,
  options: {
    readonly controlDirectory: string;
    readonly execFile?: typeof execFile;
  },
): HerdrFleetRun {
  const run = options.execFile ?? execFile;
  return (args, signal, timeoutMs = REMOTE_HERDR_TIMEOUT_MS) => {
    let command: string;
    try {
      command = remoteHerdrCommand(fleet, args);
      mkdirSync(options.controlDirectory, { recursive: true, mode: 0o700 });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return new Promise((resolve, reject) => {
      run(
        "ssh",
        sshArgs(fleet, options.controlDirectory, command),
        {
          maxBuffer: 8 * 1024 * 1024,
          timeout: timeoutMs,
          ...(signal === undefined ? {} : { signal }),
        },
        (error, stdout, stderr) => {
          const out = String(stdout);
          const reported = herdrError(out);
          if (reported !== undefined) return reject(reported);
          if (error !== null) {
            if (signal?.aborted === true) return reject(error);
            const detail = String(stderr).trim();
            return reject(
              new HerdrFleetError(
                error.killed ? "timeout" : "fleet_unreachable",
                error.killed
                  ? `fleet ${fleet.id}: herdr ${args.slice(0, 2).join(" ")} timed out after ${String(timeoutMs)} ms`
                  : `fleet ${fleet.id}: ${detail || error.message}`,
              ),
            );
          }
          resolve(out);
        },
      );
    });
  };
}
