import type { RemoteCodexLaunch, RemoteCodexRegistration } from "../remote-codex-seats.ts";
import {
  windowsCodexLaunchCommand,
  windowsCodexStopCommand,
  windowsCodexBridge,
  windowsCodexBridgeCheckCommand,
  type WindowsCodexBridgeBinding,
} from "../windows-codex-launch.ts";
import { codexControlEndpoint, codexProcess, parseHerdrForegroundProcesses } from "./codex-seat.ts";
import { codexProxyControl, type ExternalCodexControl } from "./external-codex-control.ts";
import type { FleetSeatDelivery } from "./fleet-seat.ts";
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
  readonly privateSeat?: { pane: string; register(launch: RemoteCodexLaunch): RemoteCodexRegistration };
}

interface Started {
  readonly pid: number;
  readonly log: string;
  readonly binding?: RemoteCodexLaunch["binding"];
  readonly shell?: RemoteCodexLaunch["shell"];
  readonly server?: RemoteCodexLaunch["server"];
  readonly bridge?: WindowsCodexBridgeBinding;
}

function startScript(
  fleet: HerdrFleet,
  input: {
    cwd: string;
    configArgs: readonly string[];
    port: number;
    id: string;
    env: Readonly<Record<string, string>>;
  },
): string {
  const listen = `ws://127.0.0.1:${String(input.port)}`;
  const argv = [...input.configArgs, "app-server", "--listen", listen];
  const env = Object.entries(input.env);
  if (fleet.ssh.shell === "powershell") {
    const unsafe = [...argv, input.cwd, ...env.flat()].find((value) => WINDOWS_UNSAFE.test(value));
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
      `$command = 'cmd.exe /d /s /c "${env.map(([key, value]) => `set "${key}=${value}"&& `).join("")}"' + $codex + '" ' + ${powershellLiteral(args)} + ' > "' + $log + '" 2>&1"'`,
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
    `${env.map(([key, value]) => `${key}=${posixQuote(value)} `).join("")}nohup codex ${argv.map(posixQuote).join(" ")} > "$log" 2>&1 < /dev/null &`,
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
  const parsed = line === undefined ? undefined : (JSON.parse(line) as Partial<Started>);
  if (typeof parsed?.pid !== "number" || typeof parsed.log !== "string")
    throw new Error(`The fleet did not report its Codex server: ${stdout.trim().slice(-500)}`);
  return { ...parsed, pid: parsed.pid, log: parsed.log };
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
    // Only the pane's Herdr identity crosses, so the server's MCP children find
    // their session's link; everything else comes from that machine.
    const env = Object.fromEntries(
      Object.entries(input.env ?? {}).filter(
        ([key]) => key === "HERDR_PANE_ID" || key === "HERDR_SOCKET_PATH",
      ),
    );
    if (Object.keys(env).length !== Object.keys(input.env ?? {}).length)
      throw new Error("unsupported: a remote Codex server takes its environment from its own machine");
    const id = randomUUID();
    const remotePort = options.remotePort?.() ?? randomInt(REMOTE_PORTS.min, REMOTE_PORTS.max + 1);
    const bridge = options.privateSeat ? await windowsCodexBridge() : undefined;
    const started = parseStarted(
      await shell(
        fleet.ssh.shell === "powershell"
          ? options.privateSeat
            ? windowsCodexLaunchCommand({
                session: fleet.session,
                pane: options.privateSeat.pane,
                cwd: input.cwd,
                args: [...input.configArgs, "app-server", "--listen", `ws://127.0.0.1:${remotePort}`],
                id,
                bridge: bridge!,
              })
            : powershellScriptCommand(startScript(fleet, { ...input, env, port: remotePort, id }))
          : posixScriptCommand(startScript(fleet, { ...input, env, port: remotePort, id })),
        START_TIMEOUT_MS,
      ),
    );
    const stopServer = () =>
      options.privateSeat && !started.server
        ? Promise.resolve(undefined)
        : shell(
            options.privateSeat && started.server
              ? windowsCodexStopCommand(started.server)
              : stopCommand(fleet, started.pid),
          ).catch(() => undefined);
    const registration =
      options.privateSeat &&
      started.binding &&
      started.shell &&
      started.server &&
      started.bridge &&
      [started.bridge.root, started.bridge.node, started.bridge.entry].every(
        (value) => typeof value === "string" && value.length > 0,
      )
        ? options.privateSeat.register({
            fleet,
            pane: options.privateSeat.pane,
            binding: started.binding,
            shell: started.shell,
            server: { ...started.server, port: remotePort },
          })
        : undefined;
    if (options.privateSeat && !registration) {
      await stopServer();
      throw new Error("Private remote process launch returned no atomic lifetime");
    }
    let failure: Error | undefined;
    let closed = false;
    let output = `remote log ${started.log} on ${fleet.id}`;
    let tailedAt = Date.now();
    let localPort: number;
    let forward: ChildProcess;
    let forwardErrors = "";
    try {
      localPort = await (options.freeLocalPort ?? freeLocalPort)();
      forward = (options.spawn ?? spawn)("ssh", forwardSshArgs(fleet, localPort, remotePort), {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      registration?.release();
      await stopServer();
      throw error;
    }
    forward.stderr?.setEncoding("utf8");
    forward.stderr?.on("data", (chunk: string) => {
      forwardErrors = `${forwardErrors}${chunk}`.slice(-2_000);
    });
    const dropped = (detail: string) => {
      if (closed || failure !== undefined) return;
      failure = new Error(`The ssh link to fleet ${fleet.id} dropped: ${detail}`);
      registration?.release();
      if (registration) void stopServer();
      input.onExit(null);
    };
    forward.on("error", (error) => dropped(error.message));
    forward.on("exit", (code) => dropped(forwardErrors.trim() || `ssh exited (${String(code)})`));
    const ownsListener = async (): Promise<boolean> => {
      if (!registration || !started.server) return true;
      const raw = await shell(
        powershellScriptCommand(
          [
            "$ErrorActionPreference='Stop'",
            `$rows=@(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${remotePort} -State Listen -ErrorAction SilentlyContinue)`,
            `if($rows.Count -ne 1 -or $rows[0].OwningProcess -ne ${started.server.pid}) { 'false'; exit }`,
            `$p=Get-Process -Id ${started.server.pid} -ErrorAction Stop`,
            `($p.StartTime.ToUniversalTime().ToString('O') -ceq ${powershellLiteral(started.server.startTime)} -and $p.Path -ceq ${powershellLiteral(started.server.executable)}) | ConvertTo-Json -Compress`,
          ].join("; "),
        ),
        5_000,
      ).catch(() => "false");
      return raw.trim() === "true";
    };
    return {
      ...(registration
        ? {
            remoteRegistration: registration,
            waitForClankieCatalog: true as const,
            viewConfigArgs: [
              "mcp_servers.clankie.enabled=true",
              'mcp_servers.clankie.env.NODE_OPTIONS=""',
              'mcp_servers.clankie.env.NODE_PATH=""',
              `mcp_servers.clankie.command=${JSON.stringify(started.bridge!.node)}`,
              `mcp_servers.clankie.args=${JSON.stringify([started.bridge!.entry])}`,
              `mcp_servers.clankie.env.HERDR_PANE_ID=${JSON.stringify(options.privateSeat!.pane)}`,
              `mcp_servers.clankie.env.HERDR_SOCKET_PATH=${JSON.stringify(started.binding!.socketPath)}`,
            ].flatMap((value) => ["-c", value]),
            validateCatalog: async () => {
              if (closed || failure) throw new Error("Private remote bridge is unavailable");
              if (
                (
                  await shell(windowsCodexBridgeCheckCommand(bridge!, started.bridge!), START_TIMEOUT_MS)
                ).trim() !== "bridge-current"
              )
                throw new Error("Worker bridge installation changed; no first brief was sent");
              if (closed || failure) throw new Error("Private remote bridge is unavailable");
            },
          }
        : {}),
      endpoint: `ws://127.0.0.1:${String(remotePort)}`,
      async connect() {
        if (!(await ownsListener())) return undefined;
        const socket = await openCodexSocket(`ws://127.0.0.1:${String(localPort)}/`);
        if (socket && !(await ownsListener())) {
          socket.close();
          registration?.release();
          return undefined;
        }
        // Keep the server's own words for a startup error, without an ssh call per poll.
        if (
          socket === undefined &&
          started.log &&
          failure === undefined &&
          Date.now() - tailedAt >= TAIL_INTERVAL_MS
        ) {
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
        registration?.release();
        forward.kill("SIGTERM");
        await stopServer();
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
  register?: (launch: RemoteCodexLaunch) => RemoteCodexRegistration,
): HarnessSeatAdapter {
  const bare = (arg: string) => {
    const qualified = splitFleetQualified(arg);
    return qualified?.fleet === fleet.id ? qualified.id : arg;
  };
  // The pane's Herdr identity, so the server's MCP children (the clankie
  // bridge) find this session's link and its granted tools.
  let socket: Promise<string> | undefined;
  const sessionSocket = () =>
    (socket ??= shell(remoteProgramCommand(fleet.ssh.shell, "herdr", ["session", "list", "--json"]))
      .then((stdout) => {
        const listed = JSON.parse(stdout) as { sessions?: { name?: unknown; socket_path?: unknown }[] };
        const path = listed.sessions?.find((entry) => entry.name === fleet.session)?.socket_path;
        if (typeof path !== "string" || path === "")
          throw new Error(`Herdr session ${fleet.session} is not running`);
        return path;
      })
      .catch((error: unknown) => {
        socket = undefined;
        throw error;
      }));
  return createCodexSeatAdapter({
    herdr: (args) => herdr(args.map(bare)),
    trackerOverrides: remoteCodexTrackerOverrides(fleet, shell),
    ...(register && fleet.ssh.shell === "powershell"
      ? {
          serverForView: (view: import("@clankie/agent-hosts").SeatView) =>
            remoteCodexServer({ fleet, shell, privateSeat: { pane: bare(view.paneId), register } }),
        }
      : { server: remoteCodexServer({ fleet, shell }) }),
    listenTimeoutMs: REMOTE_CODEX_LISTEN_TIMEOUT_MS,
    viewEnv: async (view) => ({ HERDR_PANE_ID: bare(view.paneId), HERDR_SOCKET_PATH: await sessionSocket() }),
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

/**
 * `codex queue` on a remote fleet's machine (VUH-1527): a Codex session
 * Clankie did not start there receives his message as its next prompt. On
 * Windows `codex` is a batch shim, and cmd.exe would reinterpret `&` or `%`
 * in the message, so the real `codex.js` runs under node.exe with exactly
 * escaped arguments; it is found once per fleet through `npm root -g`.
 */
export function remoteCodexQueue(fleet: HerdrFleet, shell: FleetShellRun) {
  let script: Promise<string> | undefined;
  const codexScript = () =>
    (script ??= shell(
      powershellScriptCommand(
        "$root = (& npm root -g 2>$null | Select-Object -First 1); $js = Join-Path $root '@openai\\codex\\bin\\codex.js'; if (-not (Test-Path -LiteralPath $js)) { throw 'Codex is not installed through npm here' }; Write-Output $js",
      ),
    )
      .then((stdout) => {
        const path = stdout.trim().split(/\r?\n/u).at(-1)?.trim();
        if (!path) throw new Error(`Codex was not found on ${fleet.id}`);
        return path;
      })
      .catch((error: unknown) => {
        script = undefined;
        throw error;
      }));
  return async (
    sessionId: string,
    text: string,
    beforeDispatch?: () => Promise<boolean>,
  ): Promise<boolean | FleetSeatDelivery> => {
    const argv = ["queue", "--thread", sessionId, "--message", text];
    const queueArgs = fleet.ssh.shell === "powershell" ? [await codexScript(), ...argv] : argv;
    if (beforeDispatch) {
      try {
        if (!(await beforeDispatch())) throw new Error("Peer authority changed; nothing was sent.");
      } catch (error) {
        return {
          outcome: "undelivered",
          deliveryStage: "unavailable",
          detail: `Codex authority changed before queue dispatch; nothing was sent: ${String(error)}`,
        };
      }
    }
    const stdout = await shell(
      fleet.ssh.shell === "powershell"
        ? remoteProgramCommand("powershell", "node", queueArgs)
        : remoteProgramCommand("posix", "codex", argv),
    );
    return !/no active session/iu.test(stdout);
  };
}

/** SSH carries only the selected fleet's existing proxy, never a new daemon. */
export function remoteCodexControl(
  fleet: HerdrFleet,
  shell: FleetShellRun,
  herdr: HerdrFleetRun,
  paneId: string,
): ExternalCodexControl {
  return async (sessionId, text, _codexHome, _endpoint, beforeDispatch) => {
    const qualified = splitFleetQualified(paneId);
    if (qualified?.fleet !== fleet.id) return undefined;
    let endpoint: string | undefined | null;
    try {
      endpoint = codexControlEndpoint(
        codexProcess(
          parseHerdrForegroundProcesses(await herdr(["pane", "process-info", "--pane", qualified.id])),
        ),
      );
    } catch {
      return undefined;
    }
    if (endpoint === null) return undefined;
    let program = "codex";
    let prefix: string[] = [];
    if (fleet.ssh.shell === "powershell") {
      // ProcessStartInfo cannot execute npm's .cmd shim. Resolve its real JS
      // entrypoint, just as the existing native queue does; transport stays raw.
      const result = JSON.parse(
        (
          await shell(
            powershellScriptCommand(
              [
                "$ErrorActionPreference = 'Stop'",
                "$path = (Get-Command codex -CommandType Application | Select-Object -First 1).Source",
                "if ($path -match '\\.cmd$') { $root = (& npm root -g 2>$null | Select-Object -First 1); $js = Join-Path $root '@openai\\codex\\bin\\codex.js'; if (-not (Test-Path -LiteralPath $js)) { throw 'Codex npm entrypoint is missing' }; @{ script = $js } | ConvertTo-Json -Compress } else { @{ script = $null } | ConvertTo-Json -Compress }",
              ].join("; "),
            ),
          )
        ).trim(),
      ) as { script?: string | null };
      if (typeof result.script === "string") {
        program = "node";
        prefix = [result.script];
      }
    }
    const control = codexProxyControl("ssh", [
      ...SSH_BASE_OPTIONS,
      "--",
      fleet.ssh.host,
      remoteProgramCommand(fleet.ssh.shell, program, [
        ...prefix,
        "app-server",
        "proxy",
        ...(endpoint === undefined ? [] : ["--sock", endpoint.slice("unix://".length)]),
      ]),
    ]);
    return beforeDispatch
      ? control(sessionId, text, undefined, undefined, beforeDispatch)
      : control(sessionId, text);
  };
}
