import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error -- manual checkout-only ESM runner.
import * as nativeRuntime from "../../../scripts/evals/lead-native-runtime.mjs";
const { createNativeFleet, nativePermissionConfig, writeNativeWrapper } = nativeRuntime;
// @ts-expect-error -- manual checkout-only ESM runner.
import { NativeOwnerAttachment, ownerSocketBinding } from "../../../scripts/evals/lead-native-attachment.mjs";
// @ts-expect-error -- manual checkout-only ESM runner.
import { terminalBenchResult, stageTerminalBench } from "../../../scripts/evals/lead-terminal-bench.mjs";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "native-factory-"));
  roots.push(root);
  mkdirSync(join(root, "tasks"), { mode: 0o700 });
  const allocations = ["one", "two"].map((key) => {
    const hostCwd = join(root, "tasks", key);
    mkdirSync(hostCwd, { mode: 0o700 });
    mkdirSync(join(hostCwd, ".git"), { mode: 0o700 });
    return {
      hostCwd,
      containerCwd: `/eval/tasks/${key}`,
      accountHome: join(root, "control", key, "auth"),
      accountLabel: key,
      accountId: key,
      model: "fixture-model",
      effort: "medium",
      email: `${key}@example.invalid`,
    };
  });
  const container = {
    root,
    id: "a".repeat(64),
    stopped: false,
    stop: vi.fn(async () => {}),
    exec: vi.fn(async () => ""),
    attach: vi.fn(),
    inspect: vi.fn(async () => ({})),
  };
  return { root, allocations, container };
}

it("builds distinct native roots, endpoints, clean wrappers and account homes without launching", () => {
  const f = fixture();
  const ownerAttachment = new NativeOwnerAttachment(f.container, { herdrSha256: "b".repeat(64) });
  const fleet = createNativeFleet({ ...f, ownerAttachment });
  expect(f.container.exec).not.toHaveBeenCalled();
  expect(f.container.attach).not.toHaveBeenCalled();
  expect(
    new Set(fleet.slots.map((slot: { runtime: { endpoint: string } }) => slot.runtime.endpoint)).size,
  ).toBe(2);
  for (const [index, key] of ["one", "two"].entries()) {
    const runtime = fleet.slots[index].runtime;
    expect(runtime.environment.CODEX_HOME).toBe(`/eval/control/${key}/auth`);
    const wrapperPath = join(f.root, "control", key, "bin", "fixture-wrapper");
    writeNativeWrapper(wrapperPath, runtime.environment, runtime.config, runtime.endpoint, {
      paneId: "w1:p1",
      model: "fixture-model",
      effort: "medium",
    });
    const wrapper = readFileSync(wrapperPath, "utf8");
    expect(wrapper).toContain('stdio:"inherit"');
    expect(wrapper).not.toContain("...process.env");
    expect(wrapper).toContain("process.env.HERDR_PANE_ID");
    expect(wrapper).not.toContain("CLANKIE_OPERATOR_TOKEN");
    expect(wrapper).not.toContain("CLANKIE_CAPTAIN_TOKEN");
    expect(wrapper).not.toContain("OPENAI_API_KEY");
    expect(wrapper).toContain("features.multi_agent=false");
    expect(wrapper).toContain(runtime.endpoint);
    const spawn = vi.fn((_path: string, _args: string[], _options: unknown) => ({ on: vi.fn() }));
    const argv = [
      ...runtime.config.flatMap((value: string) => ["-c", value]),
      "--remote",
      runtime.endpoint,
      "--model",
      "fixture-model",
      "-c",
      'model_reasoning_effort="medium"',
    ];
    const script = wrapper
      .replace(/^#![^\n]*\n/u, "")
      .replace('import { spawn } from "node:child_process";', "");
    runInNewContext(script, {
      spawn,
      process: {
        argv: ["node", wrapperPath, ...argv],
        env: {
          HERDR_PANE_ID: "w1:p1",
          CLANKIE_OPERATOR_TOKEN: "ambient-operator",
          CLANKIE_CAPTAIN_TOKEN: "ambient-captain",
          OPENAI_API_KEY: "ambient-provider",
          UNKNOWN_SECRET: "ambient-unknown",
        },
      },
    });
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0]?.[2]).toEqual({
      env: { ...runtime.environment, HERDR_PANE_ID: "w1:p1" },
      stdio: "inherit",
    });
    expect(JSON.stringify(spawn.mock.calls)).not.toContain("ambient-");
  }
});

it("rejects shared/aliased indexes and never substitutes arbitrary workspace allocations", async () => {
  const f = fixture();
  rmSync(join(f.allocations[1]!.hostCwd, ".git"), { recursive: true });
  symlinkSync(join(f.allocations[0]!.hostCwd, ".git"), join(f.allocations[1]!.hostCwd, ".git"));
  expect(() => createNativeFleet(f)).toThrow("independent");
  expect(() => nativePermissionConfig("/eval/tasks/one/../control")).toThrow("allocated");
  expect(f.container.exec).not.toHaveBeenCalled();
});

it("refuses foreign fleets/resumes before owner checks and refuses boolean attachment claims", async () => {
  const f = fixture();
  const fleet = createNativeFleet({ ...f, ownerAttachment: { attached: async () => true } });
  const seat = {
    workingDirectory: f.allocations[0]!.hostCwd,
    account: "one",
    harness: "codex",
    skills: "plain",
    model: "fixture-model",
    effort: "medium",
  };
  for (const override of [
    { fleet: "owner-fleet" },
    { resume: "old" },
    { harness: "claude" },
    { workingDirectory: "/owner/repo" },
  ]) {
    await expect(
      fleet.captainOptions.nativeLaunchPolicy.admit({
        seat: { ...seat, ...override },
        phase: "request",
        resumed: false,
      }),
    ).rejects.toThrow();
  }
  await expect(
    fleet.captainOptions.nativeLaunchPolicy.admit({ seat, phase: "request", resumed: false }),
  ).rejects.toThrow("attachment unavailable");
  expect(f.container.exec).not.toHaveBeenCalled();
  expect(f.container.stop).toHaveBeenCalledOnce();
});

it("requires a controller-created live native client with exact kernel process identity", async () => {
  const f = fixture();
  const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null });
  f.container.attach.mockResolvedValue(child);
  const attachment = new NativeOwnerAttachment(f.container, { herdrSha256: "b".repeat(64) });
  expect(await attachment.attached(f.container.id, "/eval/control/herdr.sock")).toBe(false);
  await attachment.attach();
  expect(f.container.attach).toHaveBeenCalledWith(
    expect.arrayContaining(["/usr/bin/env", "-i", "/usr/local/bin/herdr", "client"]),
  );
  let ticks = "200";
  const peers = [
    { inode: 10, peer: 20, type: 1, state: 1 },
    { inode: 20, peer: 10, type: 1, state: 1, path: "/eval/control/herdr-client.sock" },
  ];
  f.container.exec.mockImplementation(async (...args: unknown[]) =>
    JSON.stringify(
      (args[0] as string[]).includes("/usr/bin/python3")
        ? peers
        : [{ pid: 100, startTicks: ticks, socketInodes: [10] }],
    ),
  );
  expect(await attachment.attached(f.container.id, "/eval/control/herdr.sock")).toBe(true);
  ticks = "201";
  expect(await attachment.attached(f.container.id, "/eval/control/herdr.sock")).toBe(false);
  expect(await attachment.attached("other", "/eval/control/herdr.sock")).toBe(false);
  child.exitCode = 0;
  child.emit("exit", 0);
  await vi.waitFor(() => expect(f.container.stop).toHaveBeenCalledOnce());
  expect(await attachment.attached(f.container.id, "/eval/control/herdr.sock")).toBe(false);
});

it("requires complete pinned official verifier case coverage and consistent reward", () => {
  const expected = ["test_one", "test_two"];
  const report = {
    results: {
      summary: { tests: 2, passed: 2, failed: 0 },
      tests: expected.map((name) => ({ name: `test_outputs.py::${name}`, status: "passed" })),
    },
  };
  expect(terminalBenchResult(report, "1\n", expected)).toMatchObject({ status: "passed", tests: 2 });
  expect(() => terminalBenchResult({}, "1", expected)).toThrow("coverage");
  expect(() => terminalBenchResult({ results: { summary: { tests: 0 }, tests: [] } }, "1", expected)).toThrow(
    "coverage",
  );
  expect(() => terminalBenchResult(report, "0", expected)).toThrow("Inconsistent");
  report.results.tests[1]!.status = "skipped";
  expect(() => terminalBenchResult(report, "1", expected)).toThrow("skipped");
  expect(() =>
    stageTerminalBench({ sourceRoot: "/unused", taskId: "unofficial", output: "/unused" }),
  ).toThrow("Unpinned");
});

it("admits before account reads and rechecks before creating any native pane", async () => {
  const { HerdrWatchStore } = await import("../src/captain/herdr-watch.ts");
  const f = fixture();
  const accounts = vi.fn(async () => {
    throw Error("Account access must not occur");
  });
  const createTab = vi.fn(async () => "pane");
  const runner = {
    get: vi.fn(async () => {
      throw Error("No native request expected");
    }),
    resolveTerminal: vi.fn(async () => undefined),
    wait: vi.fn(async () => {
      throw Error("No wait expected");
    }),
    createTab,
    startAgent: vi.fn(async () => {}),
  };
  const policy = {
    admit: vi.fn(async () => {
      throw Error("allocation refused");
    }),
  };
  const store = new HerdrWatchStore(join(f.root, "watches.json"), {
    runner,
    codexAccounts: accounts,
    nativeLaunchPolicy: policy,
  });
  expect(
    await store.spawnSeat({
      schemaVersion: 1,
      harness: "codex",
      title: "fixture",
      workingDirectory: f.allocations[0]!.hostCwd,
    }),
  ).toMatchObject({ outcome: "failed", detail: "allocation refused" });
  expect(accounts).not.toHaveBeenCalled();
  expect(createTab).not.toHaveBeenCalled();
  const phases: string[] = [];
  const later = new HerdrWatchStore(join(f.root, "later.json"), {
    runner,
    nativeLaunchPolicy: {
      admit: async ({ phase }) => {
        phases.push(phase);
        if (phase === "launch") throw Error("revoked");
      },
    },
  });
  expect(
    await later.spawnSeat({
      schemaVersion: 1,
      harness: "pi",
      title: "fixture",
      workingDirectory: f.allocations[0]!.hostCwd,
    }),
  ).toMatchObject({ outcome: "failed" });
  expect(phases).toEqual(["request", "launch"]);
  expect(createTab).not.toHaveBeenCalled();
});

it("never labels an unrelated connected Unix fd as the Herdr owner connection", () => {
  const processes = [{ pid: 10, startTicks: "1", socketInodes: [100] }];
  const sockets = [
    { inode: 100, peer: 200, type: 1, state: 1 },
    { inode: 200, peer: 100, type: 1, state: 1, path: "/other/socket" },
  ];
  expect(ownerSocketBinding(processes, sockets)).toBeUndefined();
  sockets[1]!.path = "/eval/control/herdr-client.sock";
  expect(ownerSocketBinding(processes, sockets)).toMatchObject({ clientInode: 100, peerInode: 200 });
  sockets[1]!.peer = 101;
  expect(ownerSocketBinding(processes, sockets)).toBeUndefined();
});
