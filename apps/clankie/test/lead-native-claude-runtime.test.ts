import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  owner: true,
  capability: {} as any,
  plan: {} as any,
  mode: "",
  calls: [] as string[],
  child: undefined as any,
}));
vi.mock("../../../scripts/evals/lead-containment.mjs", () => ({
  LeadContainer: class {
    role = "native";
    id = "a".repeat(64);
    image = "sha256:" + "b".repeat(64);
    stopped = false;
    capability = {};
    root: string;
    constructor(root: string) {
      this.root = root;
    }
    async exec(args: string[]) {
      fake.calls.push(args.includes("inspect") ? "inspect" : args.includes("process-info") ? "pane" : "exec");
      if (args.includes("inspect"))
        return JSON.stringify({ ...shell, ...(fake.mode === "shell-reuse" ? { startTicks: "999" } : {}) });
      if (args.includes("process-info"))
        return JSON.stringify({
          result: {
            process_info: {
              pane_id: fake.mode === "wrong-pane" ? "w1:p2" : "w1:p1",
              shell_pid: 100,
              foreground_process_group_id: fake.mode === "background" ? 99 : 100,
              foreground_processes: [{ pid: 201 }],
            },
          },
        });
      if (args.includes("-c")) return JSON.stringify({ pid: "pid:[1]", mnt: "mnt:[1]", net: "net:[1]" });
      return "";
    }
    async pipe() {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        exitCode: null,
        signalCode: null,
        kill: vi.fn(),
      });
      fake.child = child;
      const send = (value: unknown) => queueMicrotask(() => child.stdout.write(JSON.stringify(value) + "\n"));
      child.stdin.on("data", (bytes) => {
        const request = JSON.parse(bytes.toString());
        fake.calls.push(request.op);
        if (fake.mode.startsWith("termination-failed"))
          send({ kind: "failed", reason: "native-termination-unconfirmed" });
        else if (request.op === "launch")
          send({
            kind: "held",
            shell,
            launcher: { pid: 200, parent: 100, startTicks: "150" },
            process: nativeProcess,
          });
        else {
          if (fake.mode === "owner-lost") fake.owner = false;
          send(running());
        }
      });
      setImmediate(() => {
        send({
          kind: "peer",
          pid: fake.mode === "borrowed-peer" ? 99 : 100,
          uid: processUid,
          gid: processUid,
        });
        send({ kind: "shell", shell });
      });
      return child;
    }
    async stop(reason: string) {
      fake.calls.push("stop");
      this.stopped = true;
      if (["stop-unconfirmed", "termination-failed-stop-unconfirmed"].includes(fake.mode))
        throw Error("stop unavailable");
      return { containerId: this.id, stopped: true, reason };
    }
  },
}));
vi.mock("../../../scripts/evals/lead-native-attachment.mjs", () => ({
  NativeOwnerAttachment: class {
    container: unknown;
    herdrSha256 = "d".repeat(64);
    constructor(container: unknown) {
      this.container = container;
    }
    async attached() {
      return fake.owner;
    }
  },
}));
vi.mock("../../../scripts/evals/lead-native-capability.mjs", () => ({
  nativeRuntimeEvidence: () => fake.capability,
}));
vi.mock("../../../scripts/evals/lead-native-claude-plan.mjs", () => ({
  requireNativeClaudePlan: () => fake.plan,
  stopNativeClaudeArm: (container: any, reason: string) => container.stop(reason),
}));
vi.mock("../../../scripts/evals/lead-native-claude-collector.mjs", () => ({
  writeNativeClaudeCollectorHooks: () => ({ settingsPath: "/eval/control/claude/collector/settings.json" }),
  startNativeClaudeCollector: async () => {
    fake.calls.push("collector-listening");
    return { close: vi.fn() };
  },
}));
vi.mock("../src/captain/herdr-watch.ts", () => ({
  createHerdrWatchRunner: () => ({ createTab: async () => "w1:p1" }),
}));
// @ts-expect-error -- checkout-only ESM controller.
import * as runtime from "../../../scripts/evals/lead-native-claude-runtime.mjs";
const { createNativeClaudeRuntime, nativeClaudeCollectorSelection, assertNativeClaudeSelection } = runtime;
// @ts-expect-error -- checkout-only ESM controller.
import { claudeSandboxArgs } from "../../../scripts/evals/lead-native-claude-sandbox.mjs";
// @ts-expect-error -- fixture replaces only the external container boundary.
import { LeadContainer } from "../../../scripts/evals/lead-containment.mjs";
// @ts-expect-error -- fixture replaces only the external attachment boundary.
import { NativeOwnerAttachment } from "../../../scripts/evals/lead-native-attachment.mjs";
const processUid = process.getuid!();
const shell = { pid: 100, parent: 50, group: 100, session: 100, tty: 10, foreground: 100, startTicks: "100" };
const nativeProcess = {
  pid: 201,
  parent: 200,
  group: 100,
  session: 100,
  tty: 10,
  foreground: 100,
  startTicks: "200",
};
function running() {
  return {
    kind: "running",
    process: { ...nativeProcess, ...(fake.mode === "pid-reuse" ? { startTicks: "999" } : {}) },
    namespaces: { pid: fake.mode === "namespace" ? "pid:[1]" : "pid:[2]", mnt: "mnt:[2]", net: "net:[2]" },
    root: {
      pid: 201,
      startTicks: "200",
      tty: 10,
      executableSha256: (fake.mode === "wrong-executable" ? "f" : "c").repeat(64),
      exeDevice: "1",
      exeInode: "2",
      exeBytes: 8,
      exeCtimeNs: "123",
    },
  };
}
const roots: string[] = [];
const runtimes: any[] = [];
beforeEach(() => {
  fake.owner = true;
  fake.mode = "";
  fake.calls = [];
  fake.capability = {
    runtime: "claude",
    version: "2.1.118 (Claude Code)",
    binaries: { "/opt/claude/bin/claude": "c".repeat(64), "/usr/local/bin/herdr": "d".repeat(64) },
    policy: claudeSandboxArgs({ hooks: true }),
  };
  fake.plan = {
    artifact: { sha256: "c".repeat(64), declaredVersion: "2.1.118" },
    cwd: "/eval/tasks/lead",
    sessionId: "11223344-1122-1122-1122-112233445566",
    argv: ["/opt/claude/bin/claude", "--settings", "/eval/control/claude/settings.json"],
  };
});
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop("fixture cleanup").catch(() => {});
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "claude-runtime-"));
  roots.push(root);
  mkdirSync(join(root, "control/claude"), { recursive: true, mode: 0o700 });
  const container = new LeadContainer(root);
  const ownerAttachment = new NativeOwnerAttachment(container);
  const runtime = createNativeClaudeRuntime({ container, ownerAttachment, plan: {} });
  runtimes.push(runtime);
  return { container, runtime };
}
it("binds only the controller-created held lifetime, prepares collection before release, and rejects copied tokens", async () => {
  const f = fixture();
  await f.runtime.startHerdr();
  const result = await f.runtime.launch({ output: "fixture-output" });
  expect(fake.calls.indexOf("collector-listening")).toBeLessThan(fake.calls.indexOf("release"));
  expect(nativeClaudeCollectorSelection(result.selection, f.container)).toMatchObject({
    launchPid: 201,
    launchStartTicks: "200",
  });
  await assertNativeClaudeSelection(result.selection, f.container);
  await expect(assertNativeClaudeSelection({ ...result.selection }, f.container)).rejects.toThrow(
    "Controller-owned",
  );
  expect(result).toMatchObject({ launchAllowed: false, providerAdmission: false, childRouting: false });
  fake.mode = "pid-reuse";
  await expect(assertNativeClaudeSelection(result.selection, f.container)).rejects.toThrow();
  expect(f.container.stopped).toBe(true);
  await expect(f.runtime.launch({ output: "again" })).rejects.toThrow("once");
});
for (const mode of [
  "borrowed-peer",
  "shell-reuse",
  "wrong-pane",
  "background",
  "namespace",
  "pid-reuse",
  "wrong-executable",
  "owner-lost",
]) {
  it(`refuses native selection and stops exact containment for ${mode}`, async () => {
    const f = fixture();
    await f.runtime.startHerdr();
    fake.mode = mode;
    await expect(f.runtime.launch({ output: "fixture-output" })).rejects.toThrow();
    expect(fake.calls).toContain("stop");
    expect(f.container.stopped).toBe(true);
  });
}
it("does not let Codex capability or imported labels authorize a Claude controller", () => {
  fake.capability.runtime = "codex";
  expect(fixture).toThrow("Claude image/control capability");
  expect(() => nativeClaudeCollectorSelection({ paneId: "w1:p1", trusted: true }, {})).toThrow(
    "Controller-owned",
  );
});
it("retains uncertain containment failure instead of returning a usable selection", async () => {
  const f = fixture();
  await f.runtime.startHerdr();
  fake.mode = "stop-unconfirmed";
  fake.owner = false;
  await expect(f.runtime.launch({ output: "fixture-output" })).rejects.toThrow("containment unconfirmed");
});

for (const confirmed of [true, false]) {
  it(`stops exact containment on a parked launch failure and preserves stop confirmation=${confirmed}`, async () => {
    const f = fixture();
    await f.runtime.startHerdr();
    fake.mode = confirmed ? "termination-failed" : "termination-failed-stop-unconfirmed";
    await expect(f.runtime.launch({ output: "fixture-output" })).rejects.toThrow(
      confirmed ? "termination unconfirmed" : "containment unconfirmed",
    );
    expect(fake.calls.filter((call) => call === "stop")).toHaveLength(1);
    expect(fake.calls).not.toContain("release");
  });
}
