import { describe, expect, it, vi } from "vitest";
import { createRemoteProjectObserver, createRemoteWorkspaceCanonical } from "../src/remote-project-proof.ts";
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
  const shell = vi
    .fn()
    .mockResolvedValueOnce(JSON.stringify(first))
    .mockResolvedValueOnce(JSON.stringify(last));
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
    expect(shell).toHaveBeenCalledTimes(2);
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
    expect(script).toContain("GetFinalPathNameByHandle");
    expect(script).toContain("-LocalPort 1234 -RemoteAddress 127.0.0.1 -RemotePort 2345");
    expect(script).not.toContain("Get-Location");
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
