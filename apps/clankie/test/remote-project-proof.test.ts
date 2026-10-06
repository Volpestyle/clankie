import { RemoteCodexSeats } from "../src/remote-codex-seats.ts";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";
import {
  createRemoteProjectObserver,
  createRemoteWorkspaceCanonical,
  createRemoteGitWorktreeObserver,
  createRemoteWorktreeRootObserver,
  createRemoteCodexControlObserver,
  createRemoteCodexQueueObserver,
} from "../src/remote-project-proof.ts";
import { windowsProcessCommand } from "../src/windows-process-probe.ts";
import { classifyWindowsCodexArgv } from "../src/windows-codex-argv.ts";

const fleet = { id: "pc", session: "kh2-desktop", ssh: { host: "pc", shell: "powershell" as const } };
function scriptFromCommand(command: string): string {
  const script = Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le");
  const compressed = /\$bytes=\[Convert\]::FromBase64String\('([A-Za-z0-9+/=]+)'\)/u.exec(script)?.[1];
  return compressed ? gunzipSync(Buffer.from(compressed, "base64")).toString("utf8") : script;
}
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
  it.each(["w3:p8", "pc/w3:p8"])("binds the relay-owned socket for pane address %s", async (pane) => {
    const { observe, shell } = setup();
    const proof = await observe("pc", pane, stream);
    expect(proof).toMatchObject({
      fleet: "pc",
      pane,
      processes: [{ pid: 30 }],
      workspace: { machineId: "pc", platform: "windows", canonicalPath: "C:\\repos\\rivals-agent" },
    });
    expect(shell).toHaveBeenCalledTimes(1);
    const script = scriptFromCommand(shell.mock.calls[0]![0]);
    expect(script).toContain("'w3:p8'");
    expect(script).not.toContain("'pc/w3:p8'");
  });
  it.each(["other/w3:p8", "pc/other/w3:p8", "pc/w3:p8/extra", "pc/not-a-pane"])(
    "rejects mismatched or malformed address %s before observing a host",
    async (pane) => {
      const { observe, shell, registered } = setup();
      expect(await observe("pc", pane, stream)).toBeUndefined();
      expect(registered).not.toHaveBeenCalled();
      expect(shell).not.toHaveBeenCalled();
    },
  );
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
  it.each(["unavailable", "other", "tui"])(
    "preserves a Codex project's native process proof when argv is classified %s",
    async (role) => {
      const observation = fixture();
      observation.agent.agent = "codex";
      observation.agent.agent_session.agent = "codex";
      observation.agent.agent_session.source = "herdr:codex";
      const executable = "C:\\installed\\codex.exe";
      observation.installed = [executable];
      observation.processes[2]!.executable = executable;
      const argv = role === "unavailable" ? [] : [executable, role === "other" ? "--yolo" : "--no-daemon"];
      const projection = classifyWindowsCodexArgv(argv);
      expect(projection.role).toBe(role);
      const native = { ...observation.nativeProcesses[0]!, executable, ...projection };
      observation.nativeProcesses = [native];
      // Failed argv reads and unknown flags (for example --yolo) are not
      // prerequisites for the installed native process/cwd/socket ancestry proof.
      expect(await setup(observation).observe("pc", "w3:p8", stream)).toMatchObject({
        processes: [{ pid: native.pid }],
        workspace: { canonicalPath: native.cwd },
      });
    },
  );
  it("keeps app-server excluded after an unknown trailing flag", async () => {
    const observation = fixture();
    observation.agent.agent = "codex";
    observation.agent.agent_session.agent = "codex";
    observation.agent.agent_session.source = "herdr:codex";
    const executable = "C:\\installed\\codex.exe";
    observation.installed = [executable];
    observation.processes[2]!.executable = executable;
    const projection = classifyWindowsCodexArgv([
      executable,
      "app-server",
      "--listen",
      "ws://127.0.0.1:45000",
      "--future-native-flag",
    ]);
    const native = { ...observation.nativeProcesses[0]!, executable, ...projection };
    observation.nativeProcesses = [native];
    expect(await setup(observation).observe("pc", "w3:p8", stream)).toBeUndefined();
    expect(projection).toEqual({ role: "server", endpoint: null, standalone: false });
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
    const script = scriptFromCommand(command);
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
    const script = scriptFromCommand(shell.mock.calls[0]![0]);
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

describe("standalone remote Codex queue proof", () => {
  function standaloneFixture() {
    const observation = fixture();
    const executable = "C:\\installed\\codex.exe";
    const markers = {
      pane: "w3:p8",
      socketPath: observation.binding.socketPath,
      homeHash: "a".repeat(64),
    };
    observation.agent.agent = "codex";
    observation.agent.agent_session = {
      agent: "codex",
      kind: "id",
      source: "herdr:codex",
      value: "standalone-thread",
    };
    observation.installed = [executable];
    observation.processes[2]!.executable = executable;
    return {
      ...observation,
      foregroundMarkers: markers,
      defaultHomeHash: markers.homeHash,
      nativeProcesses: [
        {
          ...observation.nativeProcesses[0]!,
          executable,
          ...classifyWindowsCodexArgv([executable, "--no-daemon"]),
          markers,
        },
      ],
    };
  }

  function observers(first = standaloneFixture(), last = structuredClone(first)) {
    const options = {
      fleet: async () => fleet,
      shell: () => async () => JSON.stringify({ first, last }),
    };
    return { queue: createRemoteCodexQueueObserver(options), project: createRemoteProjectObserver(options) };
  }

  it("requires positive standalone native evidence while retaining the default-home CLI proof", async () => {
    expect(await observers().queue("pc", "w3:p8", "standalone-thread")).toMatchObject({
      proof: { processes: [{ pid: 30 }], workspace: { canonicalPath: "C:\\repos\\rivals-agent" } },
      homeHash: "a".repeat(64),
    });
  });

  it.each([
    ["non-loopback remote", ["--remote", "wss://other.example:45000"]],
    ["remote endpoint with a trailing newline", ["--remote", "ws://127.0.0.1:45000\n"]],
  ] as const)(
    "denies standalone queue authority for %s while retaining independent project proof",
    async (_kind, args) => {
      const observation = standaloneFixture();
      const native = observation.nativeProcesses[0]!;
      const projection = classifyWindowsCodexArgv([native.executable, ...args]);
      expect(projection.endpoint).toBeNull();
      expect(projection.standalone).toBe(false);
      Object.assign(native, projection);
      const observed = observers(observation);
      expect(await observed.queue("pc", "w3:p8", "standalone-thread")).toBeUndefined();
      expect(await observed.project("pc", "w3:p8", stream)).toMatchObject({ processes: [{ pid: 30 }] });
    },
  );

  it("denies a legacy unknown standalone projection without withdrawing independent project proof", async () => {
    const observation = standaloneFixture();
    delete (observation.nativeProcesses[0] as { standalone?: boolean }).standalone;
    const observed = observers(observation);
    expect(await observed.queue("pc", "w3:p8", "standalone-thread")).toBeUndefined();
    expect(await observed.project("pc", "w3:p8", stream)).toMatchObject({ processes: [{ pid: 30 }] });
  });

  it("refuses a standalone projection that disappears before the final native observation", async () => {
    const first = standaloneFixture();
    const last = structuredClone(first);
    last.nativeProcesses[0]!.standalone = false;
    expect(await observers(first, last).queue("pc", "w3:p8", "standalone-thread")).toBeUndefined();
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
    return {
      ...x,
      nativeProcesses: x.nativeProcesses.map((process) => ({
        ...process,
        role: "tui",
        endpoint: "ws://127.0.0.1:45000",
      })),
      privateServer: { ...server, cwd: x.nativeProcesses[0]!.cwd, listeners: [60] },
    };
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
  it.each(["w3:p8", "pc/w3:p8"])("binds the registered private server for pane address %s", async (pane) => {
    const { observer } = await privateSetup();
    const proof = await observer("pc", pane, stream);
    expect(proof).toMatchObject({
      pane,
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
    "tui-backend",
    "tui-role",
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
    if (kind === "tui-backend") last.nativeProcesses[0]!.endpoint = "ws://127.0.0.1:45001";
    if (kind === "tui-role") last.nativeProcesses[0]!.role = "other";
    const { observer, registration } = await privateSetup(first, last);
    if (kind === "unbound") registration.release();
    expect(await observer("pc", "w3:p8", stream)).toBeUndefined();
  });
});

describe("Windows dedicated Codex observation boundary", () => {
  it("accepts the actual Windows private backend and native TUI launched with an initial positional prompt", async () => {
    // Captured by the actual Windows C# producer on the owned w8:pB lane,
    // 2026-10-04, Codex 0.160.0; argv/environment remain projected and bounded.
    const raw = readFileSync(
      new URL("./fixtures/windows-codex-private-control.json", import.meta.url),
      "utf8",
    );
    const registered = { id: "pc", session: "default", ssh: { host: "pc", shell: "powershell" as const } };
    const observer = createRemoteCodexControlObserver({
      fleet: async (id) => (id === registered.id ? registered : undefined),
      shell: () => async () => raw,
    });
    expect(await observer("pc", "w8:pB", "01a10928-d878-7db2-82d0-643dce239a3f")).toMatchObject({
      endpoint: "ws://127.0.0.1:52645",
      listenEndpoint: "ws://127.0.0.1:0",
      shell: { pid: 789840, startTime: "2026-10-04T22:59:51.8840955Z" },
      foreground: { pid: 686856, startTime: "2026-10-04T23:03:52.5814358Z" },
      tui: { pid: 792564, startTime: "2026-10-04T23:03:53.9980954Z" },
      server: { pid: 785568, startTime: "2026-10-04T23:03:53.4473657Z" },
      binding: { session: "default" },
    });
  });
  // The legacy PC example is codex.exe --no-daemon resume <thread> (pc-probe.log).
  // This contract replay models the approved foreground supervisor's sibling
  // --remote TUI and --listen backend; live Windows producer acceptance is separate.
  function dedicated() {
    const x = fixture();
    const executable = "C:\\installed\\codex.exe";
    const markers = { pane: "w3:p8", socketPath: x.binding.socketPath, homeHash: "a".repeat(64) };
    const endpoint = "ws://127.0.0.1:45000";
    return {
      ...x,
      agent: {
        ...x.agent,
        agent: "codex",
        agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: "private-thread" },
      },
      installed: [executable],
      foregroundMarkers: { ...markers },
      processes: [
        ...x.processes.map((p) => {
          if (p.pid === 30) return { ...p, executable };
          if (p.pid === 40) return { ...p, parent: 60 };
          return p;
        }),
        { pid: 60, parent: 20, startTime: "2026-10-03T10:00:01.0000001Z", executable },
      ],
      nativeProcesses: [
        {
          pid: 30,
          executable,
          cwd: x.nativeProcesses[0]!.cwd,
          role: "tui" as "tui" | "server" | "other" | "unavailable",
          endpoint: endpoint as string | null,
          markers: { ...markers },
          listeners: [] as { pid: number; address: string; port: number }[],
          listenerOwners: [] as number[],
        },
        {
          pid: 60,
          executable,
          cwd: x.nativeProcesses[0]!.cwd,
          role: "server" as "tui" | "server" | "other" | "unavailable",
          endpoint: "ws://127.0.0.1:0" as string | null,
          markers: { ...markers },
          listeners: [{ pid: 60, address: "127.0.0.1", port: 45000 }],
          listenerOwners: [60],
        },
      ],
    };
  }
  function replay(first = dedicated(), last = structuredClone(first)) {
    const options = {
      fleet: async (id: string) => (id === fleet.id ? fleet : undefined),
      shell: () => async (command: string) => {
        expect(command.length).toBeLessThan(32_767);
        return JSON.stringify({ first, last });
      },
    };
    return {
      control: createRemoteCodexControlObserver(options),
      project: createRemoteProjectObserver(options),
    };
  }
  it("binds native steering and the backend MCP child to the same visible TUI without private registry privilege", async () => {
    const observer = replay();
    const proof = await observer.control("pc", "w3:p8", "private-thread");
    expect(proof).toMatchObject({
      fleet: "pc",
      pane: "w3:p8",
      terminalId: "term_1",
      sessionId: "private-thread",
      endpoint: "ws://127.0.0.1:45000",
      listenEndpoint: "ws://127.0.0.1:0",
      server: { pid: 60, startTime: "2026-10-03T10:00:01.0000001Z", executable: "C:\\installed\\codex.exe" },
      tui: { pid: 30 },
      foreground: { pid: 20 },
      shell: { pid: 10 },
      binding: { session: fleet.session, socketPath: "C:\\herdr\\kh2.sock" },
      homeHash: "a".repeat(64),
    });
    const project = await observer.project("pc", "w3:p8", stream);
    expect(project).toMatchObject({
      nativeOccupantId: proof!.nativeOccupantId,
      processes: [{ pid: proof!.tui.pid }],
      workspace: { canonicalPath: "C:\\repos\\rivals-agent" },
    });
    expect(project!.privateSeat).toBeUndefined();
    expect(JSON.stringify(proof)).not.toContain("CODEX_HOME");
    expect(JSON.stringify(proof)).not.toContain("arguments");
  });
  it("accepts a fixed positive --listen port and returns identical static proof after exact connected server-half validation", async () => {
    const observation = dedicated();
    observation.nativeProcesses[1]!.endpoint = "ws://127.0.0.1:45000";
    observation.owners = [60];
    const observer = replay(observation).control;
    const initial = await observer("pc", "w3:p8", "private-thread");
    expect(initial).toBeDefined();
    expect(await observer("pc", "w3:p8", "private-thread", { clientPort: 54000, serverPort: 45000 })).toEqual(
      initial,
    );
    expect(
      await observer("pc", "w3:p8", "private-thread", { clientPort: 54000, serverPort: 45001 }),
    ).toBeUndefined();
    observation.owners = [40];
    expect(
      await replay(observation).control("pc", "w3:p8", "private-thread", {
        clientPort: 54000,
        serverPort: 45000,
      }),
    ).toBeUndefined();
  });
  it.each([
    [
      "embedded --no-daemon TUI",
      (x: ReturnType<typeof dedicated>) => {
        x.nativeProcesses[0]!.endpoint = null;
      },
    ],
    [
      "shared daemon",
      (x: ReturnType<typeof dedicated>) => {
        x.nativeProcesses[1]!.role = "other";
      },
    ],
    [
      "foreign foreground",
      (x: ReturnType<typeof dedicated>) => {
        x.processes.at(-1)!.parent = 10;
      },
    ],
    [
      "missing wrapper",
      (x: ReturnType<typeof dedicated>) => {
        x.processes = x.processes.filter((p) => p.pid !== 20);
      },
    ],
    [
      "PID reuse before child",
      (x: ReturnType<typeof dedicated>) => {
        x.processes[1]!.startTime = "2026-10-03T10:00:01.0000002Z";
      },
    ],
    [
      "replacement backend newer than TUI",
      (x: ReturnType<typeof dedicated>) => {
        x.processes.at(-1)!.startTime = "2026-10-03T10:00:02.0000001Z";
      },
    ],
    [
      "foreign listener",
      (x: ReturnType<typeof dedicated>) => {
        x.nativeProcesses[1]!.listenerOwners = [99];
      },
    ],
    [
      "ambiguous listener",
      (x: ReturnType<typeof dedicated>) => {
        x.nativeProcesses[1]!.listenerOwners = [60, 99];
      },
    ],
    [
      "second server listener",
      (x: ReturnType<typeof dedicated>) => {
        x.nativeProcesses[1]!.listeners.push({ pid: 60, address: "127.0.0.1", port: 45001 });
      },
    ],
    [
      "wildcard address",
      (x: ReturnType<typeof dedicated>) => {
        x.nativeProcesses[1]!.listeners[0]!.address = "0.0.0.0";
      },
    ],
    [
      "different native executable",
      (x: ReturnType<typeof dedicated>) => {
        x.nativeProcesses[1]!.executable = "C:\\desktop\\codex.exe";
      },
    ],
    [
      "unavailable argv",
      (x: ReturnType<typeof dedicated>) => {
        x.nativeProcesses[1]!.role = "unavailable";
      },
    ],
    [
      "different listen argv port",
      (x: ReturnType<typeof dedicated>) => {
        x.nativeProcesses[1]!.endpoint = "ws://127.0.0.1:45001";
      },
    ],
    [
      "pane marker",
      (x: ReturnType<typeof dedicated>) => {
        x.nativeProcesses[1]!.markers.pane = "w3:p9";
      },
    ],
    [
      "session/socket marker",
      (x: ReturnType<typeof dedicated>) => {
        x.foregroundMarkers.socketPath = "C:\\herdr\\other.sock";
      },
    ],
    [
      "CODEX_HOME hash",
      (x: ReturnType<typeof dedicated>) => {
        x.nativeProcesses[1]!.markers.homeHash = "b".repeat(64);
      },
    ],
    [
      "backend cwd",
      (x: ReturnType<typeof dedicated>) => {
        x.nativeProcesses[1]!.cwd = "C:\\other";
      },
    ],
  ])("refuses %s for steering and sibling-owned MCP", async (_name, mutate) => {
    const observation = dedicated();
    mutate(observation);
    const observer = replay(observation);
    expect(await observer.control("pc", "w3:p8", "private-thread")).toBeUndefined();
    expect(await observer.project("pc", "w3:p8", stream)).toBeUndefined();
  });
  it("refuses embedded-server steering while preserving the existing directly proven TUI-child MCP identity", async () => {
    const observation = dedicated();
    observation.processes.at(-1)!.parent = 30;
    observation.processes.at(-1)!.startTime = "2026-10-03T10:00:02.0000001Z";
    const observer = replay(observation);
    expect(await observer.control("pc", "w3:p8", "private-thread")).toBeUndefined();
    expect(await observer.project("pc", "w3:p8", stream)).toMatchObject({
      processes: [{ pid: 30 }],
      nativeOccupantId: (await replay().control("pc", "w3:p8", "private-thread"))!.nativeOccupantId,
    });
  });
  it.each([
    "ws://localhost:45000",
    "wss://127.0.0.1:45000",
    "ws://0.0.0.0:45000",
    "ws://127.0.0.1:45000/path",
    "ws://127.0.0.1:45000?token=secret",
    "ws://user@127.0.0.1:45000",
    "ws://127.0.0.1:0",
    "ws://127.0.0.1:65536",
  ])("refuses noncanonical frontend endpoint %s", async (endpoint) => {
    const observation = dedicated();
    observation.nativeProcesses[0]!.endpoint = endpoint;
    expect(await replay(observation).control("pc", "w3:p8", "private-thread")).toBeUndefined();
  });
  it("refuses a second TUI, a different reported session/pane/fleet, and startup without a session", async () => {
    const observation = dedicated();
    observation.nativeProcesses.push({ ...structuredClone(observation.nativeProcesses[0]!), pid: 31 });
    observation.processes.push({ ...observation.processes[2]!, pid: 31 });
    expect(await replay(observation).control("pc", "w3:p8", "private-thread")).toBeUndefined();
    const observer = replay().control;
    expect(await observer("pc", "w3:p8", "foreign-thread")).toBeUndefined();
    expect(await observer("pc", "w3:p9", "private-thread")).toBeUndefined();
    expect(await observer("other", "w3:p8", "private-thread")).toBeUndefined();
    delete (observation.agent as { agent_session?: unknown }).agent_session;
    expect(await replay(observation).control("pc", "w3:p8", "private-thread")).toBeUndefined();
  });
  it.each(["tui", "server", "shell", "wrapper", "home", "listener", "cwd"] as const)(
    "refuses changed %s proof between initial and final kernel observations",
    async (kind) => {
      const first = dedicated(),
        last = dedicated();
      const pid = { tui: 30, server: 60, shell: 10, wrapper: 20 }[
        kind as "tui" | "server" | "shell" | "wrapper"
      ];
      if (pid) last.processes.find((p) => p.pid === pid)!.startTime = "2026-10-03T10:00:02.0000002Z";
      if (kind === "home") {
        last.foregroundMarkers.homeHash = "b".repeat(64);
        for (const native of last.nativeProcesses) native.markers.homeHash = last.foregroundMarkers.homeHash;
      }
      if (kind === "listener") last.nativeProcesses[1]!.listenerOwners = [];
      if (kind === "cwd") for (const native of last.nativeProcesses) native.cwd = "C:\\other";
      const observer = replay(first, last);
      expect(await observer.control("pc", "w3:p8", "private-thread")).toBeUndefined();
      expect(await observer.project("pc", "w3:p8", stream)).toBeUndefined();
    },
  );
  it("keeps the native reader bounded and fixed-marker-only across its encoded command boundary", () => {
    const command = windowsProcessCommand({
      session: fleet.session,
      pane: "w3:p8",
      codexControl: true,
      clientPort: 45000,
      serverPort: 54000,
    });
    expect(command.length).toBeLessThan(32_767);
    const script = scriptFromCommand(command);
    expect(script).toContain("CommandLineToArgvW");
    expect(script).toContain("parameters+0x70");
    expect(script).toContain("HERDR_PANE_ID");
    expect(script).toContain("homeHash");
    expect(script).toContain("$native.standalone = if ($role) { $role.standalone } else { $false }");
    expect(script).toContain("standalone=remotes==0 && listens==0");
    expect(script).toContain('role=command=="app-server"?"server":"other"');
    expect(script).toContain("[ClankieProcess]::Owners(45000, 54000)");
    expect(script).not.toContain("Win32_Process");
    expect(script).not.toContain("ConvertTo-Json $args");
  });
});
