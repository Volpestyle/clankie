import { expect, it, vi } from "vitest";
import { runMachinesMenu } from "../src/machines-menu.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";

function fixture(choices: (string | undefined)[], texts: string[] = []) {
  const readSelect = vi.fn(async (_options: unknown) => choices.shift());
  const readText = vi.fn(async () => texts.shift());
  const insertCommandResult = vi.fn();
  const renderLine = vi.fn();
  const shell = {
    setupFlow: { begin: vi.fn(), end: vi.fn(), setStatus: vi.fn(), readSelect, readText, renderLine },
    insertCommandResult,
  } as unknown as ClankieFaceShell;
  const machines = vi.fn(async (_args: readonly string[]) => ({
    observedAt: "2026-10-03T00:00:00Z",
    machines: [
      {
        id: "local",
        transport: "local",
        configured: true,
        state: "available",
        workerCount: 2,
        sessions: [
          { name: "work", state: "available", workerCount: 2 },
          { name: "owned", state: "connected", workerCount: 0, connectionId: "default" },
          { name: "review", state: "connected", workerCount: 1, connectionId: "review" },
        ],
      },
      {
        id: "pc",
        transport: "ssh",
        ssh: "my-pc",
        shell: "powershell",
        configured: false,
        state: "available",
        workerCount: 3,
        sessions: [],
      },
    ],
  }));
  const runtime = vi.fn(async (_args: readonly string[]) => ({
    connections: [{ id: "review", capacity: 4, workspaces: [{ kind: "repository", path: "/code" }] }],
  }));
  return { shell, readSelect, readText, machines, runtime, insertCommandResult, renderLine };
}
it("lists discovered candidates before typing and adds their actual transport without a restart", async () => {
  const f = fixture(["machine:pc", undefined, undefined]);
  await runMachinesMenu(f.shell, f);
  expect(f.machines).toHaveBeenCalledWith(["add", "pc", "--ssh", "my-pc", "--shell", "powershell"]);
  expect(f.readText).not.toHaveBeenCalled();
});
it("connects a selected session through the machines command without asking its name", async () => {
  const f = fixture(["machine:local", "session:0", undefined, undefined], ["work"]);
  await runMachinesMenu(f.shell, f);
  expect(f.machines).toHaveBeenCalledWith(["sessions", "local", "--connect", "work", "--id", "work"]);
  expect(f.readText).toHaveBeenCalledTimes(1);
});
it("keeps default session safe and edits named connection capacity and grants using existing writers", async () => {
  const f = fixture(
    [
      "machine:local",
      "session:1",
      undefined,
      "session:2",
      "capacity",
      "workspaces",
      "--repo",
      "disconnect",
      "yes",
      undefined,
      undefined,
    ],
    ["8", "/new"],
  );
  await runMachinesMenu(f.shell, f);
  const menu = f.readSelect.mock.calls[2]![0] as unknown as { options: { value: string }[] };
  expect(menu.options.some((row) => row.value === "disconnect")).toBe(false);
  expect(f.runtime).toHaveBeenCalledWith(["capacity", "review", "8"]);
  expect(f.runtime).toHaveBeenCalledWith(["workspaces", "review", "--repo", "/new"]);
  expect(f.runtime).toHaveBeenCalledWith(["disconnect", "review"]);
});
it("shows errors without attempting subsequent mutations", async () => {
  const f = fixture(["machine:pc", undefined]);
  const read = f.machines.getMockImplementation()!;
  f.machines.mockImplementation(async (args) => {
    if (args[0] === "add") throw new Error("Not authorized");
    return read(args);
  });
  await runMachinesMenu(f.shell, f);
  expect(f.renderLine).toHaveBeenCalledWith("Not authorized", "error");
  expect(f.machines).not.toHaveBeenCalledWith(["sessions", "pc"]);
});

it.each(["disabled", "unreachable"])("offers reconnect for a %s named session", async (state) => {
  const f = fixture(["machine:local", "session:2", "reconnect", undefined, undefined]);
  const read = f.machines.getMockImplementation()!;
  f.machines.mockImplementation(async (args) => {
    const result = await read(args);
    result.machines[0]!.sessions[2]!.state = state;
    return result;
  });
  await runMachinesMenu(f.shell, f);
  expect(f.runtime).toHaveBeenCalledWith(["reconnect", "review"]);
});
