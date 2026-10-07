import { windowsCodexBridge, windowsCodexLaunchCommand } from "../src/windows-codex-launch.ts";
import * as externalCodex from "../src/captain/external-codex-control.ts";

import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { HerdrFleet } from "../src/herdr-fleet.ts";
import {
  forwardSshArgs,
  remoteCodexQueue,
  remoteCodexControl,
  remoteCodexServer,
  remoteCodexTrackerOverrides,
} from "../src/captain/remote-codex-app-server.ts";

const windows: HerdrFleet = { id: "pc", session: "default", ssh: { host: "volpe@pc", shell: "powershell" } };
const posix: HerdrFleet = { id: "box", session: "default", ssh: { host: "me@box", shell: "posix" } };

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The PowerShell script inside an `-EncodedCommand` remote command. */
function decoded(command: string): string {
  const encoded = /-EncodedCommand (\S+)$/u.exec(command)?.[1];
  if (encoded === undefined) throw new Error(`not an encoded command: ${command}`);
  return Buffer.from(encoded, "base64").toString("utf16le");
}

/** Unquote the shell script and verify its bootstrap before checking exact argv. */
function decodedPosixExec(command: string | undefined): string {
  const prefix = "exec sh -c '";
  if (!command?.startsWith(prefix) || !command.endsWith("'"))
    throw new Error(`not a quoted POSIX script: ${command}`);
  const script = command.slice(prefix.length, -1).replaceAll("'\\''", "'");
  const bootstrap =
    /^command -v codex >\/dev\/null 2>&1 \|\| \{ printf '%s\\n' 'clankie-launch-[a-f0-9]{16}: codex not found in PATH' >&2; exit 127; \}; /u.exec(
      script,
    );
  if (!bootstrap) throw new Error(`not a Codex launch bootstrap: ${script}`);
  return script.slice(bootstrap[0].length);
}

function fakeForward() {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  const stderr = new PassThrough();
  Object.assign(child, { stderr, kill: vi.fn(() => true) });
  const spawnFake = vi.fn(() => child) as unknown as typeof spawn;
  return { child, spawn: spawnFake };
}

async function listeningServer(): Promise<number> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  cleanups.push(() => server.close());
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  return address.port;
}

describe("a remote Codex app-server (VUH-1527)", () => {
  it("starts detached on Windows, listens on the remote loopback, and is reached through a forward", async () => {
    const localPort = await listeningServer();
    const commands: string[] = [];
    const shell = vi.fn(async (command: string) => {
      commands.push(command);
      return '{"pid":4321,"log":"C:\\\\Users\\\\volpe\\\\AppData\\\\Local\\\\clankie\\\\codex-app-servers\\\\x.log"}\r\n';
    });
    const forward = fakeForward();
    const onExit = vi.fn();
    const server = await remoteCodexServer({
      fleet: windows,
      shell,
      spawn: forward.spawn,
      freeLocalPort: async () => localPort,
      remotePort: () => 47_123,
    })({
      cwd: "C:\\src\\app",
      configArgs: ["-c", "mcp_servers.linear.enabled=false"],
      env: { HERDR_PANE_ID: "w8:p3", HERDR_SOCKET_PATH: "C:\\herdr\\herdr.sock" },
      onExit,
    });

    expect(server.endpoint).toBe("ws://127.0.0.1:47123");
    const script = decoded(commands[0]!);
    expect(script).toContain("Invoke-CimMethod -ClassName Win32_Process -MethodName Create");
    expect(script).toContain("-c mcp_servers.linear.enabled=false app-server --listen ws://127.0.0.1:47123");
    expect(script).toContain("CurrentDirectory = 'C:\\src\\app'");
    // Only the pane's Herdr identity crosses, so its MCP children find this session's link.
    expect(script).toContain(
      'cmd.exe /d /s /c "set "HERDR_PANE_ID=w8:p3"&& set "HERDR_SOCKET_PATH=C:\\herdr\\herdr.sock"&& "',
    );
    expect(forward.spawn).toHaveBeenCalledWith(
      "ssh",
      forwardSshArgs(windows, localPort, 47_123),
      expect.anything(),
    );
    expect(forwardSshArgs(windows, localPort, 47_123)).toEqual(
      expect.arrayContaining(["-N", "-L", `127.0.0.1:${String(localPort)}:127.0.0.1:47123`, "volpe@pc"]),
    );

    const socket = await server.connect();
    expect(socket).toBeDefined();
    socket?.close();

    await server.close();
    expect(forward.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(decoded(commands.at(-1)!)).toContain("taskkill.exe /PID 4321 /T /F");
    expect(onExit).not.toHaveBeenCalled();
  });

  it("starts with nohup on a POSIX machine and keeps paths quoted", async () => {
    const commands: string[] = [];
    const shell = vi.fn(async (command: string) => {
      commands.push(command);
      return '{"pid":77,"log":"/home/me/.clankie/codex-app-servers/x.log"}\n';
    });
    const forward = fakeForward();
    const server = await remoteCodexServer({
      fleet: posix,
      shell,
      spawn: forward.spawn,
      freeLocalPort: async () => 1,
      remotePort: () => 50_000,
    })({ cwd: "/home/me/it's here", configArgs: [], onExit: vi.fn() });
    expect(commands[0]).toMatch(/^exec sh -c '/u);
    // Undo the outer `sh -c '…'` quoting to read the script the remote shell runs.
    const script = commands[0]!.slice("exec sh -c '".length, -1).replaceAll("'\\''", "'");
    expect(script).toContain("nohup codex 'app-server' '--listen' 'ws://127.0.0.1:50000'");
    expect(script).toContain("cd '/home/me/it'\\''s here'");
    await server.close();
    expect(commands.at(-1)).toContain("kill -TERM 77");
  });

  it("reports a dropped ssh link as the server going away", async () => {
    const forward = fakeForward();
    const onExit = vi.fn();
    const server = await remoteCodexServer({
      fleet: windows,
      shell: async () => '{"pid":1,"log":"x.log"}',
      spawn: forward.spawn,
      freeLocalPort: async () => 1,
      remotePort: () => 45_000,
    })({ cwd: "C:\\src", configArgs: [], onExit });
    forward.child.emit("exit", 255);
    expect(onExit).toHaveBeenCalledWith(null);
    expect(server.failure()?.message).toContain("The ssh link to fleet pc dropped");
  });

  it("refuses Windows arguments cmd.exe would reinterpret, before starting anything", async () => {
    const shell = vi.fn(async () => '{"pid":1,"log":"x.log"}');
    await expect(
      remoteCodexServer({ fleet: windows, shell, spawn: fakeForward().spawn })({
        cwd: "C:\\src",
        configArgs: ["-c", 'mcp_servers."odd name".enabled=false'],
        onExit: vi.fn(),
      }),
    ).rejects.toThrow(/cannot take/u);
    expect(shell).not.toHaveBeenCalled();
  });

  it.each([
    { env: { OPENAI_API_KEY: "x" }, configArgs: [] },
    { env: { CODEX_HOME: "relative/home" }, configArgs: [] },
    { env: { CLANKIE_EXPECTED_TOOL_NAMES: "[]" }, configArgs: [] },
    {
      env: { CLANKIE_EXPECTED_TOOL_NAMES: "[]" },
      configArgs: [
        "-c",
        `mcp_servers.clankie.env.CLANKIE_EXPECTED_TOOL_NAMES=${JSON.stringify('["linear_get_issue"]')}`,
      ],
    },
    {
      env: { OPENAI_API_KEY: "x", CLANKIE_EXPECTED_TOOL_NAMES: "[]" },
      configArgs: ["-c", 'mcp_servers.clankie.env.CLANKIE_EXPECTED_TOOL_NAMES="[]"'],
    },
  ])("refuses a per-hire environment it cannot carry to the other machine: $env", async (input) => {
    const shell = vi.fn(async () => "");
    await expect(
      remoteCodexServer({ fleet: posix, shell })({
        cwd: "/src",
        ...input,
        onExit: vi.fn(),
      }),
    ).rejects.toThrow(/environment|absolute/u);
    expect(shell).not.toHaveBeenCalled();
  });

  it("runs the remote server and its tracker read as the Codex home chosen on that machine", async () => {
    const commands: string[] = [];
    const shell = vi.fn(async (command: string) => {
      commands.push(command);
      return '{"pid":4321,"log":"x.log"}';
    });
    const home = "C:\\Users\\volpe\\.codex-james";
    const server = await remoteCodexServer({
      fleet: windows,
      shell,
      spawn: fakeForward().spawn,
      freeLocalPort: async () => 1,
      remotePort: () => 47_124,
    })({ cwd: "C:\\src", configArgs: [], env: { CODEX_HOME: home }, onExit: vi.fn() });
    cleanups.push(() => void server.close());
    expect(decoded(commands[0]!)).toContain(`set "CODEX_HOME=${home}"&& `);
    await remoteCodexTrackerOverrides(windows, async (command) => {
      commands.push(command);
      return "[]";
    })("C:\\src", { CODEX_HOME: home, HERDR_PANE_ID: "w1:p1" });
    const tracker = decoded(commands.at(-1)!);
    expect(tracker).toContain(`$start.EnvironmentVariables['CODEX_HOME'] = '${home}'`);
    expect(tracker).not.toContain("HERDR_PANE_ID");
  });

  it("reads tracker connectors from the remote machine's own Codex configuration", async () => {
    const shell = vi.fn(
      async (_command: string) =>
        '[{"name":"linear","enabled":true,"transport":{"url":"https://mcp.linear.app/mcp"}},{"name":"other","enabled":true}]',
    );
    expect(await remoteCodexTrackerOverrides(windows, shell)("C:\\src")).toEqual([
      "mcp_servers.linear.enabled=false",
    ]);
    const script = decoded(shell.mock.calls[0]![0]);
    expect(script).toContain("$start.WorkingDirectory = 'C:\\src'");
  });
});

describe("replying to a Codex session Clankie did not start on another machine (VUH-1527)", () => {
  it("queues through node and codex.js on Windows, never through the cmd shim", async () => {
    const commands: string[] = [];
    const shell = vi.fn(async (command: string) => {
      commands.push(command);
      return commands.length === 1
        ? "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js\r\n"
        : "queued\r\n";
    });
    const queue = remoteCodexQueue(windows, shell);
    expect(await queue("thread-1", 'Reply "now" & 100% done')).toBe(true);
    expect(await queue("thread-1", "again")).toBe(true);
    // codex.js is found once; each message runs node.exe with exact arguments.
    expect(decoded(commands[0]!)).toContain("npm root -g");
    const run = decoded(commands[1]!);
    expect(run).toContain("Get-Command node -CommandType Application");
    expect(run).not.toContain("Get-Command codex");
    const argv = Buffer.from(/FromBase64String\('([^']+)'\)/u.exec(run)![1]!, "base64").toString("utf8");
    expect(argv).toBe(
      'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js queue --thread thread-1 --message "Reply \\"now\\" & 100% done"',
    );
    expect(commands).toHaveLength(3);
  });

  it("calls codex directly on a POSIX machine and reports a session that is gone", async () => {
    const shell = vi.fn(async (_command: string) => "Error: no active session thread-9\n");
    expect(await remoteCodexQueue(posix, shell)("thread-9", "hi")).toBe(false);
    expect(decodedPosixExec(shell.mock.calls[0]![0])).toBe(
      "exec codex 'queue' '--thread' 'thread-9' '--message' 'hi'",
    );
  });
  it.each(["off", "throws"])(
    "refuses a %s authority guard after deferred Windows script discovery without queueing",
    async (mode) => {
      let lookupStarted!: () => void;
      const lookingUp = new Promise<void>((resolve) => {
        lookupStarted = resolve;
      });
      let finishLookup!: (script: string) => void;
      const script = new Promise<string>((resolve) => {
        finishLookup = resolve;
      });
      const shell = vi.fn(async () => {
        lookupStarted();
        return script;
      });
      let authorized = true;
      const beforeDispatch = vi.fn(async () => {
        if (mode === "throws" && !authorized) throw new Error("authority lookup failed");
        return authorized;
      });
      const sending = remoteCodexQueue(windows, shell)("thread", "peer context", beforeDispatch);
      await lookingUp;
      expect(beforeDispatch).not.toHaveBeenCalled();
      authorized = false;
      finishLookup("C:\\npm\\codex.js\r\n");
      expect(await sending).toMatchObject({ outcome: "undelivered", deliveryStage: "unavailable" });
      expect(beforeDispatch).toHaveBeenCalledOnce();
      expect(shell).toHaveBeenCalledOnce();
    },
  );
});

describe("external Codex SSH proxy", () => {
  it("preserves the final authority guard after deferred SSH endpoint discovery", async () => {
    const beforeDispatch = vi.fn(async () => false);
    const delivery = vi.fn(async (...args: Parameters<externalCodex.ExternalCodexControl>) => {
      expect(await args[4]?.()).toBe(false);
      return {
        outcome: "undelivered" as const,
        deliveryStage: "unavailable" as const,
        detail: "authority off",
      };
    });
    const proxy = vi.spyOn(externalCodex, "codexProxyControl").mockReturnValue(delivery);
    let finishLookup!: (processes: string) => void;
    const processes = new Promise<string>((resolve) => {
      finishLookup = resolve;
    });
    const herdr = vi.fn(async () => processes);
    try {
      const sending = remoteCodexControl(posix, vi.fn(), herdr, "box/w1:p1")(
        "thread",
        "peer context",
        undefined,
        undefined,
        beforeDispatch,
      );
      expect(beforeDispatch).not.toHaveBeenCalled();
      finishLookup(
        JSON.stringify({
          result: {
            process_info: {
              foreground_processes: [
                { pid: 123, name: "codex", argv: ["codex", "--remote", "unix:///owned/rpc.sock"] },
              ],
            },
          },
        }),
      );
      expect(await sending).toMatchObject({ outcome: "undelivered", deliveryStage: "unavailable" });
      expect(delivery).toHaveBeenCalledWith("thread", "peer context", undefined, undefined, beforeDispatch);
      expect(decodedPosixExec(proxy.mock.calls[0]?.[1]?.at(-1))).toBe(
        "exec codex 'app-server' 'proxy' '--sock' '/owned/rpc.sock'",
      );
    } finally {
      proxy.mockRestore();
    }
  });
  it.each([posix])("keeps the proxy on fleet $id and preserves bytes", async (fleet) => {
    const delivery = vi.fn(async () => ({ outcome: "unconfirmed" as const, detail: "lost" }));
    const proxy = vi.spyOn(externalCodex, "codexProxyControl").mockReturnValue(delivery);
    try {
      const shell = vi.fn(async () => JSON.stringify({ script: "C:\\npm\\codex.js" }));
      expect(
        await remoteCodexControl(
          fleet,
          shell,
          async () =>
            JSON.stringify({
              result: {
                process_info: {
                  foreground_processes: [
                    {
                      pid: 123,
                      name: fleet.ssh.shell === "powershell" ? "codex.exe" : "codex",
                      argv: ["codex"],
                    },
                  ],
                },
              },
            }),
          `${fleet.id}/w1:p1`,
        )("exact-thread", "hello"),
      ).toEqual({
        outcome: "unconfirmed",
        detail: "lost",
      });
      const [command, args] = proxy.mock.calls[0]!;
      expect(command).toBe("ssh");
      expect(args?.at(-2)).toBe(fleet.ssh.host);
      if (fleet.ssh.shell === "posix") {
        expect(decodedPosixExec(args?.at(-1))).toBe("exec codex 'app-server' 'proxy'");
        expect(shell).not.toHaveBeenCalled();
      } else {
        const script = decoded(args!.at(-1)!);
        expect(script).toContain("Get-Command node -CommandType Application");
        expect(script).toContain("StandardOutput.BaseStream.CopyTo");
        expect(
          Buffer.from(/FromBase64String\('([^']+)'\)/u.exec(script)![1]!, "base64").toString("utf8"),
        ).toBe("C:\\npm\\codex.js app-server proxy");
      }
      expect(delivery).toHaveBeenCalledWith("exact-thread", "hello");
    } finally {
      proxy.mockRestore();
    }
  });
});

it("never tries another server for a remote private or unknown pane", async () => {
  const proxy = vi.spyOn(externalCodex, "codexProxyControl");
  const shell = vi.fn();
  try {
    for (const argv of [["codex", "--no-daemon"], ["codex", "--remote", "wss://elsewhere"], undefined]) {
      const herdr = vi.fn(async () =>
        JSON.stringify({
          result: { process_info: { foreground_processes: [{ pid: 123, name: "codex.exe", argv }] } },
        }),
      );
      expect(await remoteCodexControl(posix, shell, herdr, "box/w1:p1")("thread", "hello")).toBeUndefined();
      expect(herdr).toHaveBeenCalledWith(["pane", "process-info", "--pane", "w1:p1"]);
    }
    expect(shell).not.toHaveBeenCalled();
    expect(proxy).not.toHaveBeenCalled();
  } finally {
    proxy.mockRestore();
  }
});

it("never substitutes the Windows account daemon when a fresh kernel observation cannot prove the pane's private endpoint", async () => {
  const proxy = vi.spyOn(externalCodex, "codexProxyControl");
  const shell = vi.fn(async () => "{}");
  const herdr = vi.fn();
  try {
    expect(await remoteCodexControl(windows, shell, herdr, "pc/w1:p1")("thread", "hello")).toBeUndefined();
    expect(shell).toHaveBeenCalledOnce();
    expect(herdr).not.toHaveBeenCalled();
    expect(proxy).not.toHaveBeenCalled();
  } finally {
    proxy.mockRestore();
  }
});

it("passes the exact remote Unix endpoint into the selected fleet's proxy", async () => {
  const proxy = vi
    .spyOn(externalCodex, "codexProxyControl")
    .mockReturnValue(async () => ({ outcome: "delivered", state: "steered" }));
  try {
    const herdr = async () =>
      JSON.stringify({
        result: {
          process_info: {
            foreground_processes: [
              { pid: 123, name: "codex", argv: ["codex", "--remote", "unix:///owned/rpc.sock"] },
            ],
          },
        },
      });
    await remoteCodexControl(posix, vi.fn(), herdr, "box/w1:p1")("thread", "hello");
    expect(decodedPosixExec(proxy.mock.calls[0]?.[1]?.at(-1))).toBe(
      "exec codex 'app-server' 'proxy' '--sock' '/owned/rpc.sock'",
    );
  } finally {
    proxy.mockRestore();
  }
});

it("registers only atomic Windows launch evidence, fences the protocol listener and cleans up by lifetime", async () => {
  const localPort = await listeningServer();
  const forward = fakeForward();
  const commands: string[] = [];
  const registration = { release: vi.fn(), bindThread: vi.fn(), observeThread: vi.fn() };
  const register = vi.fn(() => registration);
  const serverLife = {
    pid: 4321,
    startTime: "2026-10-03T00:00:00.1234567Z",
    executable: "C:\\installed\\codex.exe",
  };
  const shell = vi.fn(async (command: string) => {
    commands.push(command);
    const script = decoded(command);
    if (script.includes("$created=[ClankieCodexLaunch]::Start"))
      return JSON.stringify({
        pid: 4321,
        log: "",
        server: serverLife,
        bridge: {
          root: "C:\\Users\\volpe\\.clankie\\claude-plugin\\worker",
          node: "C:\\node.exe",
          entry: "C:\\Users\\volpe\\.clankie\\claude-plugin\\worker\\bin\\fleet-mcp.mjs",
        },
        binding: { session: "default", socketPath: "C:\\herdr.sock" },
        shell: { pid: 42, startTime: "2026-10-03T00:00:00.0000001Z" },
      });
    if (script.includes("Get-NetTCPConnection")) return "true";
    if (script.includes("bridge-current")) return "bridge-current";
    return "";
  });
  const server = await remoteCodexServer({
    fleet: windows,
    shell,
    spawn: forward.spawn,
    freeLocalPort: async () => localPort,
    remotePort: () => 47123,
    privateSeat: { pane: "w1:p1", register },
  })({
    cwd: "C:\\repo",
    configArgs: [
      "-c",
      "mcp_servers.other.required=true",
      "-c",
      'mcp_servers.clankie.env.OWNER_KEEP="yes"',
      "-c",
      `mcp_servers.clankie.env.CLANKIE_EXPECTED_TOOL_NAMES=${JSON.stringify(JSON.stringify(["linear_get_issue"]))}`,
    ],
    env: {
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "C:\\herdr.sock",
      CLANKIE_EXPECTED_TOOL_NAMES: JSON.stringify(["linear_get_issue"]),
      CLANKIE_CODEX_CATALOG_OBSERVED: "1",
    },
    onExit: () => {},
  });
  expect(register).toHaveBeenCalledWith(
    expect.objectContaining({ pane: "w1:p1", server: { ...serverLife, port: 47123 } }),
  );
  const script = decoded(commands[0]!);
  expect(script).toContain("mcp_servers.other.required=true");
  expect(script).toContain('mcp_servers.clankie.env.OWNER_KEEP="yes"');
  expect(script).toContain("mcp_servers.clankie.env.CLANKIE_EXPECTED_TOOL_NAMES");
  expect(script).not.toContain("$environment['CLANKIE_EXPECTED_TOOL_NAMES']");
  expect(script).toContain("$environment['CLANKIE_CODEX_CATALOG_OBSERVED']='1'");
  expect(script).toContain("GetProcessTimes(created.process");
  expect(script).toContain("ResumeThread(created.thread)");
  expect(script.indexOf("GetProcessTimes(created.process")).toBeLessThan(
    script.indexOf("ResumeThread(created.thread)"),
  );
  expect(script).toContain("[Environment]::GetEnvironmentVariables()");
  expect(script).toContain("Worker bridge is stale or redirected");
  expect(script).toContain("Get-Command node.exe -All");
  expect(script).toContain("mcp_servers.clankie.env.HERDR_PANE_ID");
  expect(script).not.toContain("mcp_servers.clankie.env_vars=");
  expect(script).toContain('mcp_servers.clankie.env.NODE_OPTIONS=""');
  expect(server.viewConfigArgs).toContain('mcp_servers.clankie.env.NODE_OPTIONS=""');
  expect(script.indexOf("Worker bridge is stale or redirected")).toBeLessThan(
    script.indexOf("$created=[ClankieCodexLaunch]::Start"),
  );
  expect(server.viewConfigArgs).toContain('mcp_servers.clankie.command="C:\\\\node.exe"');
  await server.validateCatalog?.();
  expect(script).not.toContain("Invoke-CimMethod");
  expect(script).not.toContain("Get-Process -Id $created");
  const socket = await server.connect();
  expect(socket).toBeDefined();
  expect(commands.filter((c) => decoded(c).includes("Get-NetTCPConnection"))).toHaveLength(2);
  socket?.close();
  await server.close();
  expect(registration.release).toHaveBeenCalledOnce();
  expect(decoded(commands.at(-1)!)).toContain(
    "[ClankieCodexLaunch]::Stop(4321,'2026-10-03T00:00:00.1234567Z')",
  );
  expect(decoded(commands.at(-1)!)).not.toContain("taskkill");
});

it("releases an atomic registration and its exact process when the local forward cannot allocate", async () => {
  const registration = { release: vi.fn(), bindThread: vi.fn(), observeThread: vi.fn() };
  const shell = vi.fn(async (command: string) =>
    decoded(command).includes("$created=[ClankieCodexLaunch]::Start")
      ? JSON.stringify({
          pid: 42,
          log: "",
          bridge: { root: "C:\\worker", node: "C:\\node.exe", entry: "C:\\worker\\bin\\fleet-mcp.mjs" },
          binding: { session: "default", socketPath: "C:\\herdr.sock" },
          shell: { pid: 10, startTime: "shell" },
          server: { pid: 42, startTime: "2026-10-03T00:00:00.1234567Z", executable: "C:\\codex.exe" },
        })
      : "",
  );
  await expect(
    remoteCodexServer({
      fleet: windows,
      shell,
      privateSeat: { pane: "w1:p1", register: () => registration },
      freeLocalPort: async () => {
        throw new Error("no local port");
      },
    })({ cwd: "C:\\repo", configArgs: [], onExit: () => {} }),
  ).rejects.toThrow("no local port");
  expect(registration.release).toHaveBeenCalledOnce();
  expect(decoded(shell.mock.calls.at(-1)![0])).toContain(
    "[ClankieCodexLaunch]::Stop(42,'2026-10-03T00:00:00.1234567Z')",
  );
});

it("rejects an oversized supported Windows launch before SSH or any agent is created", async () => {
  const shell = vi.fn();
  const spawn = vi.fn();
  const register = vi.fn();
  await expect(
    remoteCodexServer({
      fleet: windows,
      shell,
      spawn,
      privateSeat: { pane: "w1:p1", register },
    })({ cwd: "C:\\repo", configArgs: ["-c", `model=${JSON.stringify("a".repeat(4000))}`], onExit: vi.fn() }),
  ).rejects.toThrow("exceeds 32000 characters; no agent created");
  expect(shell).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  expect(register).not.toHaveBeenCalled();
});

it("fits the approved 21-tool catalog and realistic Windows launch configuration within the transport limit", async () => {
  const names = [
    "linear_create_attachment",
    "linear_create_attachment_from_upload",
    "linear_extract_images",
    "linear_get_attachment",
    "linear_get_document",
    "linear_get_issue",
    "linear_get_project",
    "linear_get_status_updates",
    "linear_get_user",
    "linear_list_comments",
    "linear_list_documents",
    "linear_list_issue_labels",
    "linear_list_issue_statuses",
    "linear_list_issues",
    "linear_list_milestones",
    "linear_list_projects",
    "linear_list_teams",
    "linear_list_users",
    "linear_prepare_attachment_upload",
    "linear_save_comment",
    "linear_save_issue",
  ];
  const command = windowsCodexLaunchCommand({
    session: "kh2-desktop",
    pane: "w3:p8",
    cwd: "C:\\Users\\volpe\\repos\\rivals-agent",
    id: "fixture",
    bridge: await windowsCodexBridge(),
    args: [
      "-c",
      'model="gpt-6-astra"',
      "-c",
      'model_reasoning_effort="high"',
      "-c",
      'model_provider="openai"',
      "-c",
      'cli_auth_credentials_store="file"',
      "-c",
      "mcp_servers.other.required=true",
      "-c",
      "mcp_servers.clankie.required=false",
      "-c",
      `mcp_servers.clankie.env.CLANKIE_EXPECTED_TOOL_["linear_create_attachment", "linear_create_attachment_from_upload", "linear_extract_images", "linear_get_attachment", "linear_get_document", "linear_get_issue", "linear_get_project", "linear_get_status_updates", "linear_get_user", "linear_list_comments", "linear_list_documents", "linear_list_issue_labels", "linear_list_issue_statuses", "linear_list_issues", "linear_list_milestones", "linear_list_projects", "linear_list_teams", "linear_list_users", "linear_prepare_attachment_upload", "linear_save_comment", "linear_save_issue"]=${JSON.stringify(JSON.stringify(names))}`,
      "app-server",
      "--listen",
      "ws://127.0.0.1:45000",
    ],
  });
  expect(command.length).toBeLessThanOrEqual(32_000);
  expect(decoded(command)).toContain("if(command.Length>=32767)");
});
