/** Explicit manual proof only; never invoke from push/PR or scheduled CI. */
import { execFile, fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createResourceGovernor,
  defaultResourcePolicy,
  probeProcess,
  resourceNativeHelperPath,
  type ResourceSnapshot,
} from "@clankie/fleet-resources";
import { resourcePython } from "../../../packages/fleet-resources/src/process.ts";
import { isolatedHerdr } from "../test/fixtures/local-fleet-proof/herdr-fixture.ts";
import { startLinearFixture } from "./fleet-load-fixtures.ts";
import { startFleetLoadService, type FleetLoadServiceConfig } from "./fleet-load-service.ts";

const execute = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const sourceRoot = resolve(dirname(script), "../../..");
const args = process.argv.slice(2);
const sourcePaths = [
  "apps/clankie/scripts/fleet-resource-burst.ts",
  "apps/clankie/scripts/fleet-resource-burst-job.py",
  "apps/clankie/scripts/fleet-load-service.ts",
  "apps/clankie/src/fleet-resource-runtime.ts",
  "apps/clankie/src/captain/captain.ts",
  "apps/clankie/src/app/runtime.ts",
  "packages/fleet-resources/src/governor.ts",
  "packages/fleet-resources/src/native.py",
  "packages/fleet-resources/src/process.ts",
  "packages/fleet-resources/src/pressure.ts",
];
const sourceDigests = async () =>
  Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(join(sourceRoot, path)))
          .digest("hex"),
      ]),
    ),
  );
interface ServiceSample {
  at: number;
  cpuPercent: number;
  eventLoopP95Ms: number;
}
interface JobReceipt {
  stage: "start" | "end";
  seatId: string;
  pid: number;
  startTime: string;
  at: number;
  allocationMb: number;
  maxRssMb: number;
}
const average = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const p95 = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? null;
const health = (port: number): Promise<number> =>
  new Promise((resolveHealth, reject) => {
    const started = performance.now();
    const outgoing = request({ hostname: "127.0.0.1", port, path: "/health", agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          if (response.statusCode !== 200 || JSON.parse(body).ok !== true)
            throw new Error("Health is not ready");
          resolveHealth(performance.now() - started);
        } catch (error) {
          reject(error);
        }
      });
      response.on("error", reject);
    });
    outgoing.setTimeout(2_000, () => outgoing.destroy(new Error("Health timeout")));
    outgoing.on("error", reject);
    outgoing.end();
  });
const completion = (child: ChildProcess): Promise<void> =>
  new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? resolveExit() : reject(new Error(`Owned child exited ${code ?? signal}`)),
    );
  });
async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  await Promise.race([ended, sleep(2_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await ended;
  }
}

async function burst() {
  if (!args.includes("--run")) throw new Error("Explicit manual invocation requires --run");
  const outputIndex = args.indexOf("--output");
  const output = resolve(
    outputIndex < 0
      ? join(sourceRoot, ".local/verification/vuh1740/fleet-resource-burst.json")
      : args[outputIndex + 1]!,
  );
  const root = await mkdtemp(join(tmpdir(), "cl-resource-burst-"));
  const directory = join(root, "resources");
  const journal = join(root, "jobs.jsonl");
  const policy = {
    ...defaultResourcePolicy(),
    heavySlots: 2,
    simulatorSlots: 0,
    maxLoadRatio: 16,
    minAvailableMemoryMb: 0,
  };
  const governor = createResourceGovernor({ directory });
  const children: ChildProcess[] = [];
  const serviceSamples: ServiceSample[] = [];
  const healthSamples: { at: number; latencyMs: number; phase: string }[] = [];
  const observations: ResourceSnapshot[] = [];
  const errors: string[] = [];
  const interrupted = new AbortController();
  const stop = () => interrupted.abort(new Error("Owned manual burst interrupted"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const wait = (ms: number) => sleep(ms, undefined, { signal: interrupted.signal });
  let native: Awaited<ReturnType<typeof isolatedHerdr>> | undefined;
  let provider: Awaited<ReturnType<typeof startLinearFixture>> | undefined;
  let service: ChildProcess | undefined;
  let phase = "warmup";
  let measuring = true;
  let healthLoop: Promise<void> | undefined;
  let observer: Promise<void> | undefined;
  let observe = true;
  const report: Record<string, unknown> = { passed: false, startedAt: new Date().toISOString(), errors };
  const fail = (condition: boolean, reason: string) => {
    if (!condition) errors.push(reason);
  };
  try {
    report.sourceCommit = (await execute("git", ["rev-parse", "HEAD"], { cwd: sourceRoot })).stdout.trim();
    report.sourceDigests = await sourceDigests();
    await mkdir(join(root, "home"), { recursive: true });
    await mkdir(join(root, "workspace"), { recursive: true });
    await execute(process.execPath, [join(sourceRoot, "scripts/build-fleet-proof.mjs")], {
      cwd: sourceRoot,
      timeout: 60_000,
    });
    native = await isolatedHerdr(join(root, "logs"));
    provider = await startLinearFixture();
    await governor.configure(policy);
    const config: FleetLoadServiceConfig = {
      sourceRoot,
      root: join(root, "service"),
      workspace: join(root, "workspace"),
      socket: native.socketPath,
      herdr: "herdr",
      provider: provider.url,
      bearer: randomUUID(),
      fleetResources: { directory, policy },
    };
    await mkdir(config.root, { recursive: true });
    const configPath = join(root, "service.json");
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(CLANKIE_|HERDR_|CODEX_)/.test(key)) delete env[key];
    Object.assign(env, {
      HOME: join(root, "home"),
      CLANKIE_STATE_DIR: join(root, "state"),
      HERDR_SOCKET_PATH: native.socketPath,
      CODEX_HOME: join(root, "codex"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
    });
    service = fork(script, ["--internal-service", configPath], {
      cwd: sourceRoot,
      env,
      execArgv: process.execArgv,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    children.push(service);
    let serviceDiagnostics = "";
    service.stderr?.on("data", (chunk) => {
      serviceDiagnostics = (serviceDiagnostics + String(chunk)).slice(-32_768);
    });
    const ready = await new Promise<{ port: number; pid: number }>((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Service startup timeout: ${serviceDiagnostics}`)),
        30_000,
      );
      service!.on("message", (message: unknown) => {
        const event = message as ServiceSample & { kind: string; port: number; pid: number };
        if (event.kind === "sample") serviceSamples.push(event);
        if (event.kind === "ready") {
          clearTimeout(timer);
          done(event);
        }
      });
      service!.once("error", reject);
      service!.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Service exited ${code}: ${serviceDiagnostics}`));
      });
    });
    await health(ready.port);
    healthLoop = (async () => {
      while (measuring) {
        const at = Date.now();
        try {
          healthSamples.push({ at, latencyMs: await health(ready.port), phase });
        } catch (error) {
          errors.push(String(error));
        }
        await sleep(Math.max(0, 200 - (Date.now() - at)));
      }
    })();
    await wait(5_000);
    service.send("measure");
    phase = "baseline";
    const baselineStarted = Date.now();
    await wait(6_000);
    const burstStarted = Date.now();
    phase = "burst";
    const jobs = Array.from({ length: 10 }, (_, index) => {
      const seatId = `burst-seat-${index + 1}`;
      const child = fork(
        join(sourceRoot, "packages/fleet-resources/test/fixtures/heavy-driver.mjs"),
        [
          directory,
          seatId,
          resourcePython,
          "-I",
          join(dirname(script), "fleet-resource-burst-job.py"),
          journal,
          seatId,
          "2",
          resourceNativeHelperPath(),
        ],
        { cwd: sourceRoot, env, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      children.push(child);
      let diagnostic = "";
      child.stderr?.on("data", (chunk) => {
        diagnostic = (diagnostic + String(chunk)).slice(-4096);
      });
      return completion(child).catch((error) => {
        throw new Error(`${seatId}: ${error}; ${diagnostic}`);
      });
    });
    observer = (async () => {
      while (observe) {
        try {
          observations.push(await governor.snapshot());
        } catch (error) {
          errors.push(String(error));
          observe = false;
        }
        await sleep(1_000);
      }
    })();
    await Promise.race([
      Promise.all(jobs),
      sleep(90_000, undefined, { ref: false, signal: interrupted.signal }).then(() => {
        throw new Error("Burst timeout");
      }),
    ]);
    const burstEnded = Date.now();
    phase = "settle";
    observe = false;
    await observer;
    await wait(1_000);
    measuring = false;
    await healthLoop;
    const receipts = (await readFile(journal, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as JobReceipt);
    const starts = receipts.filter((row) => row.stage === "start");
    const ends = receipts.filter((row) => row.stage === "end");
    const timeline = [...receipts].sort((a, b) => a.at - b.at || (a.stage === "end" ? -1 : 1));
    let active = 0;
    let maxActive = 0;
    for (const row of timeline) {
      active += row.stage === "start" ? 1 : -1;
      maxActive = Math.max(maxActive, active);
    }
    const final = await governor.snapshot();
    const exited = await Promise.all(
      starts.map(async (row) => ({
        seatId: row.seatId,
        pid: row.pid,
        startTime: row.startTime,
        state: await probeProcess(row),
      })),
    );
    const baselineCpu = serviceSamples
      .filter((sample) => sample.at > baselineStarted + 1_000 && sample.at <= burstStarted)
      .map((sample) => sample.cpuPercent);
    const burstCpu = serviceSamples
      .filter((sample) => sample.at > burstStarted + 1_000 && sample.at <= burstEnded)
      .map((sample) => sample.cpuPercent);
    const baselineHealth = healthSamples
      .filter((sample) => sample.phase === "baseline")
      .map((sample) => sample.latencyMs);
    const burstHealth = healthSamples
      .filter((sample) => sample.phase === "burst")
      .map((sample) => sample.latencyMs);
    const metrics = {
      maxActive,
      maxUsed: Math.max(...observations.map((state) => state.capacity.used)),
      maxQueued: Math.max(...observations.map((state) => state.queue.length)),
      elapsedMs: burstEnded - burstStarted,
      startDelaysMs: starts.map((row) => row.at - burstStarted),
      baselineCpuMeanPercent: average(baselineCpu),
      burstCpuMeanPercent: average(burstCpu),
      baselineHealthP95Ms: p95(baselineHealth),
      burstHealthP95Ms: p95(burstHealth),
      maxJobRssMb: Math.max(...receipts.map((row) => row.maxRssMb)),
    };
    fail(
      starts.length === 10 && ends.length === 10 && new Set(starts.map((row) => row.seatId)).size === 10,
      "Ten commands must start and finish exactly once",
    );
    fail(
      maxActive === 2 && active === 0 && metrics.maxUsed <= 2,
      "Two-slot admission must bound actual command overlap",
    );
    fail(
      metrics.maxQueued >= 1 && metrics.elapsedMs >= 10_000,
      "Burst must exercise real queueing across five waves",
    );
    // Only this fixed ten-by-two-second, two-slot fixture has a wall-time budget.
    // Production heavy commands may wait legitimately for occupied permits.
    fail(metrics.elapsedMs <= 30_000, "Fixed command burst exceeds 30s completion budget");
    fail(
      metrics.startDelaysMs[0] !== undefined && metrics.startDelaysMs[0] <= 5_000,
      "Empty-pool command admission exceeds 5s",
    );
    fail(
      final.leases.length === 0 &&
        final.queue.length === 0 &&
        exited.every((proof) => proof.state === "exited"),
      "Owned commands and registry permits must settle",
    );
    fail(baselineCpu.length >= 3 && burstCpu.length >= 5, "Insufficient CPU metadata window");
    fail(
      metrics.baselineHealthP95Ms !== null &&
        metrics.baselineHealthP95Ms <= 250 &&
        metrics.burstHealthP95Ms !== null &&
        metrics.burstHealthP95Ms <= 250,
      "Health p95 exceeds 250ms",
    );
    fail(
      metrics.baselineCpuMeanPercent !== null &&
        metrics.baselineCpuMeanPercent <= 10 &&
        metrics.burstCpuMeanPercent !== null &&
        metrics.burstCpuMeanPercent <= 10,
      "Service CPU mean exceeds 10% of one core",
    );
    fail(
      JSON.stringify(report.sourceDigests) === JSON.stringify(await sourceDigests()),
      "Measured source inputs changed during the owned run",
    );
    Object.assign(report, {
      policy,
      budgets: {
        healthP95Ms: 250,
        serviceCpuMeanPercent: 10,
        fixedBurstCompletionMs: 30_000,
        emptyPoolAdmissionMs: 5_000,
      },
      metrics,
      receipts,
      exited,
      samples: { service: serviceSamples, health: healthSamples, resources: observations },
      finalResources: final,
      servicePid: ready.pid,
      providerCalls: provider.calls.length,
      limits: [
        "Manual bounded fixture, not the 120s release fleet gate",
        "Actual Captain/service and governor with private registry; load16/memory0 are explicit fixture owner policy overrides",
        "Ten real 16MiB command jobs; no native coding TUI, external model/provider traffic, or CoreSimulator",
        "CPU measures the actual service process; child helper CPU is separate",
      ],
    });
  } catch (error) {
    errors.push(String(error));
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    measuring = false;
    observe = false;
    await Promise.allSettled([healthLoop, observer]);
    if (service?.connected) {
      const exited = new Promise<void>((done) => service!.once("exit", () => done()));
      service.send("stop");
      await Promise.race([exited, sleep(2_000, undefined, { ref: false })]);
    }
    await Promise.allSettled(children.map(stopChild));
    await provider?.close().catch((error) => errors.push(String(error)));
    await native?.close().catch((error) => errors.push(String(error)));
    await governor.close();
    await rm(root, { recursive: true, force: true });
    Object.assign(report, {
      passed: errors.length === 0,
      completedAt: new Date().toISOString(),
      cleanup: {
        ownedChildrenExited: children.every((child) => child.exitCode !== null || child.signalCode !== null),
        privateDirectoryRemoved: true,
      },
    });
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  }
  process.stdout.write(
    `${JSON.stringify({ passed: report.passed, output, metrics: report.metrics, errors })}\n`,
  );
  if (!report.passed) process.exitCode = 1;
}

if (args.includes("--internal-service")) {
  await startFleetLoadService(
    JSON.parse(
      await readFile(args[args.indexOf("--internal-service") + 1]!, "utf8"),
    ) as FleetLoadServiceConfig,
  );
} else if (args.includes("--help")) {
  process.stdout.write(
    "Manual ONLY: heavy pnpm exec tsx apps/clankie/scripts/fleet-resource-burst.ts --run [--output PATH]\n",
  );
} else await burst();
