import { RemoteCodexSeats } from "../src/remote-codex-seats.ts";

import { describe, expect, it, vi } from "vitest";
import {
  createRemoteProjectObserver,
  createRemoteWorkspaceCanonical,
  createRemoteGitWorktreeObserver,
  createRemoteWorktreeRootObserver,
} from "../src/remote-project-proof.ts";
import { windowsProcessCommand } from "../src/windows-process-probe.ts";

const fleet = { id: "pc", session: "kh2-desktop", ssh: { host: "pc", shell: "powershell" as const } };
function fixture() {
  const executable = "C:\\installed\\claude.exe";
  return {
    binding: { session: fleet.session, socketPath: "C:\\herdr\\kh2.sock" },
    info: { pane_id: "w3:p8", shell_pid: 10, foreground_process_group_id: 20 },
    agent: {
      pane_id: "w3:p8",
      terminal_id: "term_1",
      agent: "claude",
      agent_status: "idle",
      agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "native-session" },
    },
    processes: [
      { pid: 10, parent: 999, startTime: "2026-10-03T10:00:00.000Z", executable: "C:\\Windows\\pwsh.exe" },
      { pid: 20, parent: 10, startTime: "2026-10-03T10:00:01.000Z", executable: "C:\\Windows\\cmd.exe" },
      { pid: 30, parent: 20, startTime: "2026-10-03T10:00:02.000Z", executable },
      { pid: 40, parent: 30, startTime: "2026-10-03T10:00:03.000Z", executable: "C:\\node.exe" },
    ],
    nativeProcesses: [{ pid: 30, executable, cwd: "C:\\repos\\rivals-agent" }],
    owners: [40],
    installed: [executable],
  };
}
const stream = { clientPort: 1234, serverPort: 2345, alive: () => true };
function setup(first = fixture(), last = structuredClone(first)) {
  const shell = vi.fn().mockResolvedValue(JSON.stringify({ first, last }));
  const registered = vi.fn().mockResolvedValue(fleet);
  return {
    shell,
    registered,
    observe: createRemoteProjectObserver({ fleet: registered, shell: () => shell }),
  };
}
describe("remote project process proof", () => {
  it("binds a relay-owned socket through the native process and wrapper to the live shell", async () => {
    const { observe, shell } = setup();
    const proof = await observe("pc", "w3:p8", stream);
    expect(proof).toMatchObject({
      fleet: "pc",
      pane: "w3:p8",
      processes: [{ pid: 30 }],
      workspace: { machineId: "pc", platform: "windows", canonicalPath: "C:\\repos\\rivals-agent" },
    });
    expect(shell).toHaveBeenCalledTimes(1);
  });
  it("proves a native startup with no reported session using a disjoint process identity", async () => {
    const observation = fixture();
    delete (observation.agent as { agent_session?: unknown }).agent_session;
    const proof = await setup(observation).observe("pc", "w3:p8", stream);
    expect(proof?.nativeSessionPending).toBe(true);
    expect(proof?.nativeOccupantId).toMatch(/^process-/u);
    expect(proof?.workspace?.canonicalPath).toBe("C:\\repos\\rivals-agent");
  });

  it("allows host doctor observation without pretending it authenticates a socket", async () => {
    expect(await setup().observe("pc", "w3:p8")).toBeDefined();
  });
  it.each([
    [
      "unrelated socket owner",
      (x: ReturnType<typeof fixture>) => {
        x.owners = [10];
      },
    ],
    [
      "ambiguous owners",
      (x: ReturnType<typeof fixture>) => {
        x.owners = [40, 30];
      },
    ],
    [
      "no socket owner",
      (x: ReturnType<typeof fixture>) => {
        x.owners = [];
      },
    ],
    [
      "another pane",
      (x: ReturnType<typeof fixture>) => {
        x.info.pane_id = "w3:p9";
      },
    ],
    [
      "another Herdr session",
      (x: ReturnType<typeof fixture>) => {
        x.binding.session = "other";
      },
    ],
    [
      "uninstalled executable",
      (x: ReturnType<typeof fixture>) => {
        x.installed = [];
      },
    ],
    [
      "missing ancestor",
      (x: ReturnType<typeof fixture>) => {
        x.processes = x.processes.filter((p) => p.pid !== 20);
      },
    ],
    [
      "cyclic ancestor",
      (x: ReturnType<typeof fixture>) => {
        x.processes[1]!.parent = 30;
      },
    ],
    [
      "reused parent PID",
      (x: ReturnType<typeof fixture>) => {
        x.processes[1]!.startTime = "2026-10-03T11:00:00.000Z";
      },
    ],
    [
      "same-millisecond later parent PID reuse",
      (x: ReturnType<typeof fixture>) => {
        x.processes[1]!.startTime = "2026-10-03T10:00:02.0000002Z";
        x.processes[2]!.startTime = "2026-10-03T10:00:02.0000001Z";
      },
    ],
    [
      "foreground shell",
      (x: ReturnType<typeof fixture>) => {
        x.info.foreground_process_group_id = 10;
      },
    ],
    [
      "relative cwd",
      (x: ReturnType<typeof fixture>) => {
        x.nativeProcesses[0]!.cwd = "repos";
      },
    ],
  ])("denies %s", async (_name, mutate) => {
    const observation = fixture();
    mutate(observation);
    expect(await setup(observation).observe("pc", "w3:p8", stream)).toBeUndefined();
  });
  it.each([
    [
      "PID lifetime",
      (x: ReturnType<typeof fixture>) => {
        x.processes[3]!.startTime = "2026-10-03T12:00:00.000Z";
      },
    ],
    [
      "cwd",
      (x: ReturnType<typeof fixture>) => {
        x.nativeProcesses[0]!.cwd = "C:\\other";
      },
    ],
    [
      "native session",
      (x: ReturnType<typeof fixture>) => {
        x.agent.agent_session.value = "replacement";
      },
    ],
    [
      "pane shell",
      (x: ReturnType<typeof fixture>) => {
        x.info.shell_pid = 11;
      },
    ],
    [
      "binding socket",
      (x: ReturnType<typeof fixture>) => {
        x.binding.socketPath = "C:\\replacement.sock";
      },
    ],
  ])("denies a changed %s during observation", async (_name, mutate) => {
    const first = fixture(),
      last = fixture();
    mutate(last);
    expect(await setup(first, last).observe("pc", "w3:p8", stream)).toBeUndefined();
  });
  it("denies SSH failure, stream closure, removed fleet, and another machine", async () => {
    const failure = setup();
    failure.shell.mockReset().mockRejectedValue(new Error("SSH down"));
    expect(await failure.observe("pc", "w3:p8", stream)).toBeUndefined();
    expect(await setup().observe("pc", "w3:p8", { ...stream, alive: () => false })).toBeUndefined();
    const changed = setup();
    changed.registered.mockResolvedValueOnce(fleet).mockResolvedValue(undefined);
    expect(await changed.observe("pc", "w3:p8", stream)).toBeUndefined();
    expect(await setup().observe("kh2", "w3:p8", stream)).toBeUndefined();
  });
  it("builds an encoded script with kernel cwd reads and exact TCP tuple queries", () => {
    const command = windowsProcessCommand({
      session: "kh2-desktop",
      pane: "w3:p8",
      clientPort: 1234,
      serverPort: 2345,
    });
    const script = Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le");
    expect(script).toContain("ReadProcessMemory");
    expect(script).toContain("DuplicateHandle(handle, directoryHandle");
    expect(script).toContain("parameters + 0x48");
    expect(script).toContain("GetFinalPathNameByHandle");
    expect(script).toContain("[ClankieProcess]::Owners(1234, 2345)");
    expect(script).toContain("GetExtendedTcpTable");
    expect(script).not.toContain("Get-Location");
  });
  it("observes remote Git facts only on the registered Windows machine", async () => {
    const facts = {
      cwd: "C:\\work\\topic",
      worktreePath: "C:\\work\\topic",
      gitDirectory: "C:\\repo\\.git\\worktrees\\topic",
      commonDirectory: "C:\\repo\\.git",
      repoPath: "C:\\repo",
      repoCommonDirectory: "C:\\repo\\.git",
      registeredWorktrees: ["C:\\work\\topic"],
      gitFilePath: "C:\\work\\topic\\.git",
      gitDirectoryBacklink: "C:\\work\\topic\\.git",
    };
    const shell = vi.fn(async (_command: string) => JSON.stringify(facts));
    const options = { fleet: async () => fleet, shell: () => shell };
    const observe = createRemoteGitWorktreeObserver(options);
    expect(await observe({ machineId: "pc", repoPath: "C:\\repo" }, "C:\\work\\topic")).toEqual(facts);
    expect(await observe({ machineId: "other", repoPath: "C:\\repo" }, "C:\\work\\topic")).toBeUndefined();
    const script = Buffer.from(shell.mock.calls[0]![0].split(" ").at(-1)!, "base64").toString("utf16le");
    expect(script).toContain("'worktree','list','--porcelain','-z'");
    expect(script).toContain("Join-Path $gitDir 'gitdir'");
    shell.mockRejectedValue(new Error("SSH failed"));
    expect(await observe({ machineId: "pc", repoPath: "C:\\repo" }, "C:\\work\\topic")).toBeUndefined();
    const root = createRemoteWorktreeRootObserver(options);
    expect(
      await root({ machineId: "pc", platform: "posix", path: "/work", repoPath: "/repo" }),
    ).toBeUndefined();
    expect(
      await root({ machineId: "pc", platform: "windows", path: "C:\\work", repoPath: "C:\\repo" }),
    ).toBeUndefined();
  });

  it("canonicalizes only on the registered Windows fleet and fails on SSH loss", async () => {
    const shell = vi.fn().mockResolvedValue(JSON.stringify("C:\\repos"));
    const canonical = createRemoteWorkspaceCanonical({ fleet: async () => fleet, shell: () => shell });
    expect(await canonical("pc", "C:\\repos")).toBe("C:\\repos");
    expect(await canonical("other", "C:\\repos")).toBeUndefined();
    shell.mockRejectedValue(new Error("SSH gone"));
    expect(await canonical("pc", "C:\\repos")).toBeUndefined();
  });
});

describe("registered private remote Codex proof", () => {
  function privateFixture() {
    const x = fixture();
    x.agent.agent = "codex";
    x.agent.agent_session = { agent: "codex", kind: "id", source: "herdr:codex", value: "private-thread" };
    const executable = "C:\\installed\\codex.exe";
    x.installed = [executable];
    x.nativeProcesses[0]!.executable = executable;
    x.processes[2]!.executable = executable;
    x.processes[3]!.parent = 60;
    const server = { pid: 60, startTime: "2026-10-03T10:00:01.0000001Z", executable, port: 45000 };
    x.processes.push({ ...server, parent: 999 });
    return { ...x, privateServer: { ...server, cwd: x.nativeProcesses[0]!.cwd, listeners: [60] } };
  }
  async function privateSetup(first = privateFixture(), last = structuredClone(first)) {
    const seats = new RemoteCodexSeats(async () => fleet);
    const server = first.privateServer;
    const registration = seats.register(
      {
        fleet,
        pane: "w3:p8",
        binding: first.binding,
        shell: { pid: 10, startTime: first.processes[0]!.startTime },
        server: {
          pid: server.pid,
          startTime: server.startTime,
          executable: server.executable,
          port: server.port,
        },
      },
      () => true,
    );
    registration.bindThread("private-thread", async () => true);
    const observer = createRemoteProjectObserver({
      fleet: async () => fleet,
      shell: () => async () => JSON.stringify({ first, last }),
      privateSeats: seats,
    });
    return { observer, registration };
  }
  it("binds the real socket to registered native server ancestry and independently proves the live view", async () => {
    const { observer } = await privateSetup();
    const proof = await observer("pc", "w3:p8", stream);
    expect(proof).toMatchObject({
      privateSeat: true,
      processes: [{ pid: 30 }],
      workspace: { canonicalPath: "C:\\repos\\rivals-agent" },
    });
  });
  it.each([
    "server-reuse",
    "cwd",
    "listener",
    "socket-owner",
    "thread",
    "shell-reuse",
    "executable",
    "unbound",
  ] as const)("denies changed %s private evidence", async (kind) => {
    const first = privateFixture();
    const last = structuredClone(first);
    if (kind === "server-reuse") last.privateServer.startTime = "2026-10-03T10:00:01.0000002Z";
    if (kind === "cwd") last.privateServer.cwd = "C:\\outside";
    if (kind === "listener") last.privateServer.listeners = [61];
    if (kind === "socket-owner") last.owners = [61];
    if (kind === "thread") last.agent.agent_session.value = "other-thread";
    if (kind === "shell-reuse") last.processes[0]!.startTime = "2026-10-03T10:00:00.0000002Z";
    if (kind === "executable") last.privateServer.executable = "C:\\fake.exe";
    const { observer, registration } = await privateSetup(first, last);
    if (kind === "unbound") registration.release();
    expect(await observer("pc", "w3:p8", stream)).toBeUndefined();
  });
});
