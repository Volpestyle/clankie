import { spawn, type ChildProcess } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  SSH_BASE_OPTIONS,
  posixQuote,
  posixScriptCommand,
  powershellLiteral,
  powershellScriptCommand,
  remoteProgramCommand,
  splitFleetQualified,
  type FleetShellRun,
  type HerdrFleet,
  type HerdrFleetRun,
} from "../herdr-fleet.ts";
import type { HarnessSeatAdapter } from "@clankie/agent-hosts";
import { openCodexSocket, type CodexServerLauncher } from "./codex-app-server.ts";
import { createCodexSeatAdapter } from "./codex-seat-adapter.ts";
import { codexTrackerOverridesFromList } from "./tracker-isolation.ts";

/**
 * A Codex seat on another machine (VUH-1527, ADR 0213 phase 2) gets the same
 * channel a local one has: a dedicated app-server, with the native TUI in that
 * machine's Herdr pane as its second client. The server runs on the fleet's
 * machine, detached so it outlives the ssh call that started it, and listens
 * on that machine's loopback only. This machine reaches it through its own ssh
 * port forward, so no port is exposed to the network and nothing new is
 * installed there.
 */

/** Ports the remote server may take; chosen here, since ssh cannot report one back. */
const REMOTE_PORTS = { min: 41_000, max: 60_999 } as const;
const START_TIMEOUT_MS = 30_000;
const TAIL_INTERVAL_MS = 5_000;
/** A remote server starts over ssh and, on Windows, through PowerShell. */
const REMOTE_CODEX_LISTEN_TIMEOUT_MS = 45_000;

/**
 * Arguments reach a Windows server through `cmd.exe`, which reinterprets quotes
 * and its own metacharacters. Refuse those rather than launch a server whose
 * configuration silently differs from what was asked.
 */
const WINDOWS_UNSAFE = /["&|<>^%!\r\n]/u;

export interface RemoteCodexServerOptions {
  readonly fleet: HerdrFleet;
  /** Runs one remote command over the fleet's multiplexed connection. */
  readonly shell: FleetShellRun;
  /** Test seams. */
  readonly spawn?: typeof spawn;
  readonly freeLocalPort?: () => Promise<number>;
  readonly remotePort?: () => number;
}

interface Started {
  readonly pid: number;
  readonly log: string;
}

function startScript(
  fleet: HerdrFleet,
  input: { cwd: string; configArgs: readonly string[]; port: number; id: string },
): string {
  const listen = `ws://127.0.0.1:${String(input.port)}`;
  const argv = [...input.configArgs, "app-server", "--listen", listen];
  if (fleet.ssh.shell === "powershell") {
    const unsafe = [...argv, input.cwd].find((value) => WINDOWS_UNSAFE.test(value));
    if (unsafe !== undefined)
      throw new Error(`unsupported: a remote Windows Codex server cannot take ${JSON.stringify(unsafe)}`);
    const args = argv.map((value) => (/\s/u.test(value) ? `"${value}"` : value)).join(" ");
    return [
      "$ErrorActionPreference = 'Stop'",
      "$codex = (Get-Command codex -CommandType Application | Select-Object -First 1).Source",
      "$dir = Join-Path $env:LOCALAPPDATA 'clankie\\codex-app-servers'",
      "New-Item -ItemType Directory -Force $dir | Out-Null",
      `$log = Join-Path $dir ${powershellLiteral(`${input.id}.log`)}`,
      // `/s /c "…"` strips exactly the outer quotes, so the program path and
      // the log path keep theirs. Win32_Process.Create starts the server
      // outside this ssh session's job, so it survives the session.
      `$command = 'cmd.exe /d /s /c ""' + $codex + '" ' + ${powershellLiteral(args)} + ' > "' + $log + '" 2>&1"'`,
      `$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $command; CurrentDirectory = ${powershellLiteral(input.cwd)} }`,
      "if ($created.ReturnValue -ne 0) { throw ('Win32_Process.Create failed: ' + $created.ReturnValue) }",
      "@{ pid = [int]$created.ProcessId; log = $log } | ConvertTo-Json -Compress",
    ].join("; ");
  }
  return [
    "set -e",
    'dir="$HOME/.clankie/codex-app-servers"',
    'mkdir -p "$dir"',
    `log="$dir/${input.id}.log"`,
    `cd ${posixQuote(input.cwd)}`,
    // nohup and a closed stdin detach it from this ssh session.
    `nohup codex ${argv.map(posixQuote).join(" ")} > "$log" 2>&1 < /dev/null &`,
    'printf \'{"pid":%s,"log":"%s"}\\n\' "$!" "$log"',
  ].join("\n");
}

function stopCommand(fleet: HerdrFleet, pid: number): string {
  // The recorded pid is the launcher (cmd.exe or nohup's shell child); end its tree.
  return fleet.ssh.shell === "powershell"
    ? powershellScriptCommand(`taskkill.exe /PID ${String(pid)} /T /F | Out-Null; exit 0`)
    : posixScriptCommand(
        `pkill -TERM -P ${String(pid)} 2>/dev/null; kill -TERM ${String(pid)} 2>/dev/null; exit 0`,
      );
}

function tailCommand(fleet: HerdrFleet, log: string): string {
  return fleet.ssh.shell === "powershell"
    ? powershellScriptCommand(
        `Get-Content -LiteralPath ${powershellLiteral(log)} -Tail 20 -ErrorAction SilentlyContinue`,
      )
    : posixScriptCommand(`tail -n 20 ${posixQuote(log)} 2>/dev/null; exit 0`);
}

function parseStarted(stdout: string): Started {
  const line = stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .reverse()
    .find((entry) => entry.startsWith("{"));
  const parsed = line === undefined ? undefined : (JSON.parse(line) as { pid?: unknown; log?: unknown });
  if (typeof parsed?.pid !== "number" || typeof parsed.log !== "string")
    throw new Error(`The fleet did not report its Codex server: ${stdout.trim().slice(-500)}`);
  return { pid: parsed.pid, log: parsed.log };
}

function freeLocalPort(): Promise<number> {
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
    "ExitOnForwardFailure=yes",
    "-N",
    "-L",
    `127.0.0.1:${String(localPort)}:127.0.0.1:${String(remotePort)}`,
    "--",
    fleet.ssh.host,
  ];
}

export function remoteCodexServer(options: RemoteCodexServerOptions): CodexServerLauncher {
  const { fleet, shell } = options;
  return async (input) => {
    if (input.env !== undefined && Object.keys(input.env).length > 0)
      throw new Error("unsupported: a remote Codex server takes its environment from its own machine");
    const id = randomUUID();
    const remotePort = options.remotePort?.() ?? randomInt(REMOTE_PORTS.min, REMOTE_PORTS.max + 1);
    const started = parseStarted(
      await shell(
        fleet.ssh.shell === "powershell"
          ? powershellScriptCommand(startScript(fleet, { ...input, port: remotePort, id }))
          : posixScriptCommand(startScript(fleet, { ...input, port: remotePort, id })),
        START_TIMEOUT_MS,
      ),
    );
    let failure: Error | undefined;
    let closed = false;
    let output = `remote log ${started.log} on ${fleet.id}`;
    let tailedAt = Date.now();
    const localPort = await (options.freeLocalPort ?? freeLocalPort)();
    let forward: ChildProcess;
    let forwardErrors = "";
    try {
      forward = (options.spawn ?? spawn)("ssh", forwardSshArgs(fleet, localPort, remotePort), {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      await shell(stopCommand(fleet, started.pid)).catch(() => undefined);
      throw error;
    }
    forward.stderr?.setEncoding("utf8");
    forward.stderr?.on("data", (chunk: string) => {
      forwardErrors = `${forwardErrors}${chunk}`.slice(-2_000);
    });
    const dropped = (detail: string) => {
      if (closed || failure !== undefined) return;
      failure = new Error(`The ssh link to fleet ${fleet.id} dropped: ${detail}`);
      input.onExit(null);
    };
    forward.on("error", (error) => dropped(error.message));
    forward.on("exit", (code) => dropped(forwardErrors.trim() || `ssh exited (${String(code)})`));
    return {
      endpoint: `ws://127.0.0.1:${String(remotePort)}`,
      async connect() {
        const socket = await openCodexSocket(`ws://127.0.0.1:${String(localPort)}/`);
        // Keep the server's own words for a startup error, without an ssh call per poll.
        if (socket === undefined && failure === undefined && Date.now() - tailedAt >= TAIL_INTERVAL_MS) {
          tailedAt = Date.now();
          output = (await shell(tailCommand(fleet, started.log)).catch(() => output)).trim() || output;
        }
        return socket;
      },
      failure: () => failure,
      output: () => output,
      async close() {
        if (closed) return;
        closed = true;
        forward.kill("SIGTERM");
        await shell(stopCommand(fleet, started.pid)).catch(() => undefined);
      },
    };
  };
}

/**
 * Codex control for one remote fleet. Seat pane ids arrive qualified
 * (`pc/w2:p1`, ADR 0184); that fleet's Herdr takes its own bare ids.
 */
export function createRemoteCodexSeatAdapter(
  fleet: HerdrFleet,
  shell: FleetShellRun,
  herdr: HerdrFleetRun,
): HarnessSeatAdapter {
  const bare = (arg: string) => {
    const qualified = splitFleetQualified(arg);
    return qualified?.fleet === fleet.id ? qualified.id : arg;
  };
  return createCodexSeatAdapter({
    herdr: (args) => herdr(args.map(bare)),
    trackerOverrides: remoteCodexTrackerOverrides(fleet, shell),
    server: remoteCodexServer({ fleet, shell }),
    listenTimeoutMs: REMOTE_CODEX_LISTEN_TIMEOUT_MS,
  });
}

/** Tracker isolation for a remote Codex seat, read from that machine's own configuration. */
export function remoteCodexTrackerOverrides(fleet: HerdrFleet, shell: FleetShellRun) {
  return async (cwd: string): Promise<string[]> => {
    const stdout = await shell(
      remoteProgramCommand(fleet.ssh.shell, "codex", ["mcp", "list", "--json"], cwd),
    ).catch((error: unknown) => {
      throw new Error(
        `Could not read Codex's MCP servers on fleet ${fleet.id} to switch off inherited Linear connectors: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return codexTrackerOverridesFromList(stdout);
  };
}
