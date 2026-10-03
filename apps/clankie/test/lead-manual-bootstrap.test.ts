import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  events: [] as string[],
  configs: [] as any[],
  observers: [] as any[],
  controllers: [] as any[],
  captains: [] as any[],
  services: [] as any[],
  sourceClean: true,
  sendMode: "accepted",
  missingCensus: false,
  historicalReady: true,
  stopConfirmed: true,
  calibrationStopUnconfirmed: false,
  gradeFailure: undefined as string | undefined,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    lstatSync: (path: string, ...args: any[]) => {
      const stat = fs.lstatSync(path, ...(args as []));
      return String(path).endsWith("/docker.sock") ? Object.assign(stat, { isSocket: () => true }) : stat;
    },
  };
});
vi.mock("node:child_process", async (original) => {
  const child = await original<typeof import("node:child_process")>();
  return {
    ...child,
    execFileSync: (file: string, args: string[], options: any) => {
      if (file === "/usr/bin/git" && args.includes("--porcelain=v1"))
        return Buffer.from(fake.sourceClean ? "" : " M changed.ts\n");
      if (file === "/usr/bin/git" && args.at(-2) === "rev-parse" && args.at(-1) === "HEAD")
        return Buffer.from("a".repeat(40) + "\n");
      return child.execFileSync(file, args, options);
    },
  };
});
vi.mock("../../../scripts/evals/lead.mjs", async () => ({
  loadTasks: () => ({
    historical: [{ id: "history", kind: "historical", prompt: "Fix the pinned task", timeBudgetSeconds: 10 }],
    neutral: [
      { id: "photonic-waveguide-routing", timeBudgetSeconds: 10 },
      { id: "html-js-filter", timeBudgetSeconds: 10 },
    ],
  }),
  prepareReplay: async () => {
    throw Error("historical fixture is replaced per test");
  },
}));
vi.mock("../../../scripts/evals/lead-containment.mjs", () => ({
  dockerTransport: (config: unknown) => {
    fake.events.push("docker-transport");
    fake.configs.push(config);
    return () => {};
  },
  LeadContainer: class {
    root: string;
    id = "c".repeat(64);
    stopped = false;
    signal = new AbortController().signal;
    constructor(input: any) {
      this.root = input.root;
      fake.events.push("container");
    }
    async create(argv: string[]) {
      expect(argv).toEqual(["/usr/bin/sleep", "infinity"]);
      fake.events.push("create");
    }
    async start() {
      fake.events.push("start");
    }
    async exec() {
      if (!fake.historicalReady) throw Error("missing Linux tools");
      return "";
    }
    async stop() {
      fake.events.push("container-stop");
      this.stopped = true;
      return { stopped: fake.stopConfirmed, containerId: this.id };
    }
  },
}));
vi.mock("../../../scripts/evals/lead-native-image.mjs", () => ({
  buildNativeImage: async (input: any) => {
    expect(
      input.taskEnvironment?.fixtureEnvironmentBrand ?? input.historicalEnvironment?.fixtureHistoricalBrand,
    ).toBe(true);
    expect(!(input.taskEnvironment && input.historicalEnvironment)).toBe(true);
    fake.events.push("build");
    return { image: "sha256:" + "b".repeat(64) };
  },
}));
vi.mock("../../../scripts/evals/lead-historical.mjs", () => ({
  stageHistorical: () => {
    fake.events.push("historical-stage");
    return Object.freeze({ fixtureProfile: true });
  },
  stageHistoricalWorkspace: (profile: any, output: string) => {
    expect(profile.fixtureProfile).toBe(true);
    mkdirSync(output, { mode: 0o700 });
    mkdirSync(join(output, ".git"));
    writeFileSync(join(output, "TASK.md"), "Pinned historical task");
    fake.events.push("historical-workspace");
  },
  buildHistoricalDependencies: async (input: any) => {
    expect(input.platform).toBe("linux/arm64");
    expect(input.profile.fixtureProfile).toBe(true);
    fake.events.push("historical-build");
    return Object.freeze({
      fixtureHistoricalBrand: true,
      evidence: { nodeSha256: "a".repeat(64), pnpmSha256: "b".repeat(64) },
    });
  },
  calibrateHistorical: async (input: any) => {
    expect(input.build.fixtureHistoricalBrand).toBe(true);
    expect(fake.events).not.toContain("observer-create");
    fake.events.push("historical-calibrate");
    if (fake.calibrationStopUnconfirmed)
      throw Object.assign(Error("stop uncertain"), { code: "historical-stop-unconfirmed" });
    if (!fake.historicalReady) throw Error("calibration unavailable");
    return Object.freeze({ fixtureCalibration: true });
  },
  materializeHistoricalDependencies: async (input: any) => {
    expect(input.build.fixtureHistoricalBrand).toBe(true);
    expect(input.containerCwd).toMatch(/^\/eval\/tasks\/(lead|worker-[12])$/);
    mkdirSync(join(input.root, "worktree/node_modules"));
    fake.events.push("historical-materialize");
  },
  requireHistoricalEnvironment: async (build: any) => ({ evidence: build.evidence }),
  collectHistoricalPatch: ({ output }: any) => {
    fake.events.push("historical-patch");
    return join(output, "candidate.patch");
  },
  gradeHistorical: async (input: any) => {
    expect(input.calibration.fixtureCalibration).toBe(true);
    expect(fake.events).toContain("container-stop");
    fake.events.push("historical-grade");
    if (fake.gradeFailure)
      throw Object.assign(Error("fixture grading unavailable"), { code: fake.gradeFailure });
    return { status: "passed", coverage: { executedTests: 11 } };
  },
}));
vi.mock("../../../scripts/evals/lead-native-capability.mjs", () => ({
  probeNativeRuntime: async () => {
    fake.events.push("probe");
    return {};
  },
  nativeRuntimeEvidence: () => ({ binaries: { "/usr/local/bin/herdr": "d".repeat(64) } }),
}));
vi.mock("../../../scripts/evals/lead-native-attachment.mjs", () => ({
  NativeOwnerAttachment: class {
    async attach() {
      fake.events.push("owner-attach");
    }
    async attached() {
      fake.events.push("owner-proof");
      return true;
    }
  },
}));
vi.mock("../../../scripts/evals/lead-native-runtime.mjs", () => ({
  createNativeFleet: (input: any) => {
    fake.configs.push(input);
    fake.events.push("fleet");
    return {
      ...input,
      slots: input.allocations.map((allocation: any) => ({ allocation })),
      startHerdr: async () => {
        fake.events.push("herdr");
      },
    };
  },
}));
vi.mock("../../../scripts/evals/lead-admission.mjs", () => ({
  createLeadAdmission: (input: any) => {
    fake.events.push("admission");
    const seen = new Set();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      registerObserver: () => {
        fake.events.push("observer-register");
      },
      signal: new AbortController().signal,
      observe: async (snapshot: any) => {
        seen.add(snapshot.accountId);
        fake.events.push("quota:" + snapshot.accountId);
        if (seen.size === input.accountIds.length) release();
        await gate;
      },
      admit: async () => {
        expect(seen.size).toBe(input.accountIds.length);
        fake.events.push("admit");
      },
      assertCurrent() {},
      close: async () => {
        fake.events.push("admission-close");
      },
    };
  },
}));
vi.mock("../../../scripts/evals/lead-account-observer.mjs", () => ({
  createLeadAccountObserver: (input: any) => {
    fake.observers.push(input);
    fake.events.push("observer-create");
    return {
      start: async () => {
        await input.onSnapshot({ accountId: input.allocation.accountId });
        fake.events.push("observer-ready");
      },
      assertReady() {},
      stop: async () => {
        fake.events.push("observer-stop");
      },
    };
  },
}));
vi.mock("../../../scripts/evals/lead-controller.mjs", () => ({
  createLeadController: async (input: any) => {
    expect(fake.events.filter((event) => event === "observer-ready")).toHaveLength(input.observers.length);
    fake.controllers.push(input);
    fake.events.push("controller");
    return {
      captainOptions: {
        evalSessionBoundary: {},
        nativeCensusRunner: fake.missingCensus ? undefined : () => {},
        nativeHerdrRunner: {},
        nativeSummariesPath: input.summariesPath,
      },
      signal: new AbortController().signal,
      evidence: () => ({ usage: "fixture" }),
      close: async () => {
        fake.events.push("controller-close");
      },
    };
  },
}));
vi.mock("../../../scripts/evals/lead-terminal-bench.mjs", () => ({
  stageTerminalBench: ({ output }: any) => {
    mkdirSync(output, { mode: 0o700 });
    writeFileSync(join(output, "instruction.md"), "Pinned neutral task", { mode: 0o400 });
    fake.events.push("official-stage");
    return Object.freeze({ output, fixtureBrand: true });
  },
  TerminalBenchBridge: class {
    constructor({ staged }: any) {
      expect(staged.fixtureBrand).toBe(true);
      fake.events.push("official-bridge");
    }
    stageWorkspaceInputs(path: string) {
      writeFileSync(join(path, "layout_spec.json"), "{}", { mode: 0o600 });
    }
    async build(role: string) {
      fake.events.push("official-build:" + role);
      return { image: "sha256:" + "e".repeat(64), fixtureEnvironmentBrand: role === "environment" };
    }
    async buildHtml() {
      fake.events.push("html-build");
      return { image: "sha256:" + "f".repeat(64) };
    }
    async probeHtml() {
      fake.events.push("html-probe");
    }
    async verify() {
      fake.events.push("official-verify");
      return { status: "passed", tests: 1 };
    }
  },
}));
vi.mock("../src/captain/captain.ts", () => ({
  createCaptain: (deps: any, options: any) => {
    fake.captains.push({ deps, options });
    fake.events.push("captain");
    return {
      close: async () => {
        fake.events.push("captain-close");
      },
    };
  },
}));
vi.mock("../src/app.ts", () => ({
  createClankieApp: async (input: any) => {
    fake.services.push(input);
    fake.events.push("app");
    return {
      close: () => {
        fake.events.push("app-close");
      },
      app: {
        fetch: async (request: Request) => {
          expect(await input.authenticateOperator(request)).toEqual({
            operatorId: "manual-bootstrap",
            steerSourceLane: "api",
          });
          const body = await request.json();
          if (body.op === "get")
            return Response.json({
              conversation: { conversationId: "global-default", scope: { kind: "global" }, revision: 0 },
            });
          fake.events.push("task-send");
          if (fake.sendMode === "uncertain") throw Error("private internal lost response");
          return Response.json({ op: "send", result: { status: fake.sendMode, runId: "fixture" } });
        },
      },
    };
  },
}));
vi.mock("../../../packages/discord-presence-core/src/index.ts", () => ({
  DiscordVoiceTranscriptStore: class {
    path: string;
    constructor(path: string) {
      this.path = path;
    }
  },
}));
// @ts-expect-error -- explicit manual checkout entry.
import * as bootstrap from "../../../scripts/evals/lead-manual-bootstrap.mjs";
const roots: string[] = [];
const tty = {
  input: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
  output: Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
};
beforeEach(() => {
  for (const list of [
    fake.events,
    fake.configs,
    fake.observers,
    fake.controllers,
    fake.captains,
    fake.services,
  ])
    list.length = 0;
  Object.assign(fake, {
    sourceClean: true,
    sendMode: "accepted",
    missingCensus: false,
    historicalReady: true,
    stopConfirmed: true,
    calibrationStopUnconfirmed: false,
    gradeFailure: undefined,
  });
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
  for (const [stream, descriptor] of [
    [process.stdin, tty.input],
    [process.stdout, tty.output],
  ] as const) {
    if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
    else Reflect.deleteProperty(stream, "isTTY");
  }
});
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "manual-bootstrap-"));
  roots.push(root);
  const runParent = join(root, "runs"),
    dockerConfig = join(root, "docker"),
    auth = join(root, "auth");
  for (const path of [runParent, dockerConfig, auth]) mkdirSync(path, { mode: 0o700 });
  const authFile = join(auth, "auth.json"),
    socketPath = join(root, "docker.sock");
  writeFileSync(authFile, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fake-only" } }), {
    mode: 0o600,
  });
  writeFileSync(socketPath, "fake socket");
  const config: any = {
    schemaVersion: 1,
    ownerDecisionReference: "explicit manual fixture; not approval",
    arm: "clankie-hires",
    task: { kind: "neutral", id: "photonic-waveguide-routing" },
    repetition: 1,
    timeBudgetSeconds: 1,
    runParent,
    runName: "once",
    sourceHead: "a".repeat(40),
    manifestSha256: createHash("sha256")
      .update(readFileSync(new URL("../../../scripts/evals/lead-tasks.json", import.meta.url)))
      .digest("hex"),
    leadModel: "fixed-model",
    workerModel: "fixed-model",
    effort: "medium",
    accounts: [
      { role: "lead", label: "lead", accountId: "account-a", email: "a@example.invalid", authFile },
      { role: "worker-1", label: "worker-one", accountId: "account-b", email: "b@example.invalid", authFile },
      { role: "worker-2", label: "worker-two", accountId: "account-a", email: "a@example.invalid", authFile },
    ],
    docker: { socketPath, configDirectory: dockerConfig },
    nativeBuild: {
      codexSource: "/fixture/codex",
      herdrSource: "/fixture/herdr",
      rustImage: "rust:1.96.1-bookworm@sha256:" + "b".repeat(64),
      nodeImage: "node:24.20.0-bookworm@sha256:" + "b".repeat(64),
    },
    terminalBenchSource: "/fixture/bench",
  };
  const path = join(root, "manual.json");
  const write = () => writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  write();
  return { root, path, config, write };
}
it("has no import/start effects and rejects no-arg/default entry", async () => {
  expect(fake.events).toEqual([]);
  await expect(bootstrap.manualBootstrapMain([])).rejects.toThrow(/tsx/);
  expect(fake.events).toEqual([]);
});
it("requires real terminal/private config and rejects forged invocation/secret-shaped extra keys", async () => {
  const f = fixture();
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  expect(() => bootstrap.readManualInvocation(f.path)).toThrow(/terminal/);
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  chmodSync(f.path, 0o644);
  expect(() => bootstrap.readManualInvocation(f.path)).toThrow(/private/);
  chmodSync(f.path, 0o600);
  const invocation = bootstrap.readManualInvocation(f.path);
  expect(invocation.approvalEstablished).toBe(false);
  await expect(bootstrap.runManualBootstrap({ ...invocation })).rejects.toThrow(/Private/);
  writeFileSync(f.path, JSON.stringify({ ...f.config, bearer: "not-allowed" }), { mode: 0o600 });
  expect(() => bootstrap.readManualInvocation(f.path)).toThrow(/strict/);
  expect(fake.events).toEqual([]);
});
it("refuses config mutation and dirty source before any bootstrap effects", async () => {
  const f = fixture(),
    invocation = bootstrap.readManualInvocation(f.path);
  f.config.runName = "changed";
  f.write();
  await expect(bootstrap.runManualBootstrap(invocation)).rejects.toThrow(/changed/);
  fake.sourceClean = false;
  expect(() => bootstrap.readManualInvocation(f.path)).toThrow(/clean/);
  expect(fake.events).toEqual([]);
});
it("keeps the native Claude arm explicitly unsupported without creating any native lifecycle", async () => {
  const f = fixture();
  f.config.arm = "native-subagents";
  f.write();
  expect(await bootstrap.runManualBootstrap(bootstrap.readManualInvocation(f.path))).toMatchObject({
    status: "unsupported",
    approvalEstablished: false,
  });
  expect(fake.events).toEqual([]);
});
it("composes real entry seams in order, independently stages indexes/auth, sends once and confirms deadline stop", async () => {
  vi.useFakeTimers();
  const f = fixture(),
    invocation = bootstrap.readManualInvocation(f.path);
  const running = bootstrap.runManualBootstrap(invocation);
  await vi.waitFor(() => expect(fake.events).toContain("task-send"));
  expect(fake.events.indexOf("official-build:environment")).toBeLessThan(fake.events.indexOf("build"));
  expect(fake.events.indexOf("build")).toBeLessThan(fake.events.indexOf("probe"));
  expect(fake.events.indexOf("owner-proof")).toBeLessThan(fake.events.indexOf("observer-create"));
  expect(fake.events.indexOf("observer-ready")).toBeLessThan(fake.events.indexOf("captain"));
  expect(fake.observers).toHaveLength(2);
  expect(fake.events.filter((entry) => entry === "observer-register")).toHaveLength(2);
  const { leadAllocation, workerFleet } = fake.controllers[0];
  const allocations = [leadAllocation, ...workerFleet.allocations];
  expect(new Set(allocations.map((item: any) => realpathSync(join(item.hostCwd, ".git")))).size).toBe(3);
  expect(new Set(allocations.map((item: any) => item.accountHome)).size).toBe(3);
  expect(fake.observers[1].allocation.accountHome).not.toBe(allocations[1].accountHome);
  for (const allocation of allocations) {
    expect(readdirSync(allocation.hostCwd)).not.toContain("scripts");
    expect(readFileSync(join(allocation.hostCwd, "TASK.md"), "utf8")).not.toContain("grader");
  }
  await expect(fake.captains[0].deps.browser.call()).rejects.toThrow(/unavailable/);
  const app = fake.services[0];
  expect(app.settings.path).toContain("/state/");
  expect(app.voiceTranscriptStore.path).toContain("/state/");
  await vi.advanceTimersByTimeAsync(1100);
  const result = await running;
  expect(result).toMatchObject({ status: "stopped", accepted: true, modelConsumptionProven: false });
  expect(fake.events.filter((entry) => entry === "task-send")).toHaveLength(1);
  expect(fake.events).toContain("container-stop");
  expect(fake.events).toContain("official-verify");
  expect(result.taskResult).toMatchObject({
    taskId: f.config.task.id,
    acceptedRunId: "fixture",
    verifier: { status: "passed" },
  });
  await expect(bootstrap.runManualBootstrap(invocation)).rejects.toThrow(/resume/);
});
it.each(["uncertain", "revision_conflict"])(
  "never replays a %s send and retains the attempted receipt",
  async (mode) => {
    const f = fixture();
    fake.sendMode = mode;
    const result = await bootstrap.runManualBootstrap(bootstrap.readManualInvocation(f.path));
    expect(result).toMatchObject({ status: "failed", sendAttempted: true, retryAllowed: false });
    expect(fake.events.filter((entry) => entry === "task-send")).toHaveLength(1);
    expect(readFileSync(join(f.config.runParent, "once/task-send-attempt.json"), "utf8")).toContain(
      "attempted",
    );
    expect(readFileSync(join(f.config.runParent, "once/failure.json"), "utf8")).not.toContain(
      "private internal",
    );
  },
);
it("refuses a controller missing the exact native census before constructing Captain", async () => {
  const f = fixture();
  fake.missingCensus = true;
  expect(await bootstrap.runManualBootstrap(bootstrap.readManualInvocation(f.path))).toMatchObject({
    status: "failed",
    sendAttempted: false,
  });
  expect(fake.captains).toHaveLength(0);
  expect(fake.events).toContain("container-stop");
});
it("retains stop-unconfirmed rather than a finished claim", async () => {
  const f = fixture();
  fake.sendMode = "uncertain";
  fake.stopConfirmed = false;
  expect(await bootstrap.runManualBootstrap(bootstrap.readManualInvocation(f.path))).toMatchObject({
    status: "stop-unconfirmed",
    retryAllowed: false,
  });
});

function historicalFixture() {
  const f = fixture();
  f.config.task = { kind: "historical", id: "history" };
  const pnpmTarball = join(f.root, "pnpm.tgz");
  writeFileSync(pnpmTarball, "fake pnpm", { mode: 0o600 });
  f.config.historicalBuild = {
    platform: "linux/arm64",
    nodeImage: f.config.nativeBuild.nodeImage,
    pnpmTarball,
    pnpmSha256: createHash("sha256").update("fake pnpm").digest("hex"),
  };
  f.write();
  return f;
}
it("requires exact strict historical artifact/platform configuration before effects", () => {
  const f = historicalFixture();
  f.config.historicalBuild.calibration = { passed: true };
  f.write();
  expect(() => bootstrap.readManualInvocation(f.path)).toThrow(/strict/);
  delete f.config.historicalBuild.calibration;
  f.config.historicalBuild.platform = undefined;
  f.write();
  expect(() => bootstrap.readManualInvocation(f.path)).toThrow(/pinned historical/);
  f.config.historicalBuild.platform = "linux/arm64";
  writeFileSync(f.config.historicalBuild.pnpmTarball, "changed");
  f.write();
  expect(() => bootstrap.readManualInvocation(f.path)).toThrow(/artifact changed/);
  expect(fake.events).toEqual([]);
});
it("historical calibration failure remains unsupported before accounts/native lifecycle", async () => {
  const f = historicalFixture();
  fake.historicalReady = false;
  expect(await bootstrap.runManualBootstrap(bootstrap.readManualInvocation(f.path))).toMatchObject({
    status: "unsupported",
    reason: "historical-linux-prerequisite-unavailable",
    sendAttempted: false,
  });
  expect(fake.events).toContain("historical-calibrate");
  expect(fake.events).not.toContain("build");
  expect(fake.observers).toHaveLength(0);
});
it("composes historical dependencies and earned calibration before native accounts, grading only after stop", async () => {
  vi.useFakeTimers();
  const f = historicalFixture();
  const running = bootstrap.runManualBootstrap(bootstrap.readManualInvocation(f.path));
  await vi.waitFor(() => expect(fake.events).toContain("task-send"));
  expect(fake.events.indexOf("historical-calibrate")).toBeLessThan(fake.events.indexOf("build"));
  expect(fake.events.filter((event) => event === "historical-materialize")).toHaveLength(3);
  expect(fake.events).not.toContain("official-stage");
  await vi.advanceTimersByTimeAsync(1100);
  expect(await running).toMatchObject({ status: "stopped", taskResult: { verifier: { status: "passed" } } });
  expect(fake.events.indexOf("container-stop")).toBeLessThan(fake.events.indexOf("historical-grade"));
});
it("refuses absent exact task runtime before observer/account startup", async () => {
  const f = fixture();
  fake.historicalReady = false;
  expect(await bootstrap.runManualBootstrap(bootstrap.readManualInvocation(f.path))).toMatchObject({
    status: "unsupported",
    reason: "native-task-environment-unavailable",
    accountStarted: false,
  });
  expect(fake.observers).toHaveLength(0);
  expect(fake.events).not.toContain("captain");
  expect(fake.events).toContain("official-build:environment");
});

it("rejects conflicting account labels for the same selected native identity", () => {
  const f = fixture();
  f.config.accounts[2]!.email = "different@example.invalid";
  f.write();
  expect(() => bootstrap.readManualInvocation(f.path)).toThrow(/Conflicting/);
  expect(fake.events).toEqual([]);
});
it("owner interruption stops the exact fake container and does not start a verifier", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const running = bootstrap.runManualBootstrap(bootstrap.readManualInvocation(f.path));
  await vi.waitFor(() => expect(fake.events).toContain("task-send"));
  process.emit("SIGINT");
  const result = await running;
  expect(result).toMatchObject({
    status: "stopped",
    reason: "owner-interrupt",
    taskResult: { status: "unavailable" },
  });
  expect(fake.events).toContain("container-stop");
  expect(fake.events).not.toContain("official-verify");
});

it("composes the HTML native environment before its separate mediated verifier", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.config.task.id = "html-js-filter";
  f.write();
  const running = bootstrap.runManualBootstrap(bootstrap.readManualInvocation(f.path));
  await vi.waitFor(() => expect(fake.events).toContain("task-send"));
  expect(fake.events.indexOf("html-build")).toBeLessThan(fake.events.indexOf("html-probe"));
  expect(fake.events.indexOf("html-probe")).toBeLessThan(fake.events.indexOf("observer-create"));
  expect(fake.events.lastIndexOf("observer-register")).toBeLessThan(fake.events.indexOf("quota:account-a"));
  await vi.advanceTimersByTimeAsync(1100);
  expect(await running).toMatchObject({
    taskResult: { taskId: "html-js-filter", verifier: { status: "passed" } },
  });
});

it("retains historical preparation stop uncertainty rather than an unsupported settled claim", async () => {
  const f = historicalFixture();
  fake.calibrationStopUnconfirmed = true;
  expect(await bootstrap.runManualBootstrap(bootstrap.readManualInvocation(f.path))).toMatchObject({
    status: "stop-unconfirmed",
    sendAttempted: false,
  });
  expect(fake.observers).toHaveLength(0);
});

it.each(["historical-stop-unconfirmed", "artifact-unavailable"])(
  "preserves grading failure classification without claiming a confirmed verifier stop: %s",
  async (code) => {
    vi.useFakeTimers();
    const f = historicalFixture();
    fake.gradeFailure = code;
    const running = bootstrap.runManualBootstrap(bootstrap.readManualInvocation(f.path));
    await vi.waitFor(() => expect(fake.events).toContain("task-send"));
    await vi.advanceTimersByTimeAsync(1100);
    const result = await running;
    expect(result).toMatchObject({
      status: code === "historical-stop-unconfirmed" ? "stop-unconfirmed" : "verification-unavailable",
      verifierStopConfirmed: false,
      taskResult: {
        status: "unavailable",
        reason: code === "historical-stop-unconfirmed" ? code : "historical-verifier-or-artifact-unavailable",
      },
    });
    expect(result.taskResult.verifier).toBeUndefined();
    expect(JSON.parse(readFileSync(join(f.config.runParent, "once/result.json"), "utf8"))).toEqual(result);
  },
);
