import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { HerdrFleet } from "../src/herdr-fleet.ts";
import {
  forwardSshArgs,
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
      onExit,
    });

    expect(server.endpoint).toBe("ws://127.0.0.1:47123");
    const script = decoded(commands[0]!);
    expect(script).toContain("Invoke-CimMethod -ClassName Win32_Process -MethodName Create");
    expect(script).toContain("-c mcp_servers.linear.enabled=false app-server --listen ws://127.0.0.1:47123");
    expect(script).toContain("CurrentDirectory = 'C:\\src\\app'");
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

  it("refuses a per-hire environment it cannot carry to the other machine", async () => {
    const shell = vi.fn(async () => "");
    await expect(
      remoteCodexServer({ fleet: posix, shell })({
        cwd: "/src",
        configArgs: [],
        env: { CODEX_HOME: "/x" },
        onExit: vi.fn(),
      }),
    ).rejects.toThrow(/environment/u);
    expect(shell).not.toHaveBeenCalled();
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
