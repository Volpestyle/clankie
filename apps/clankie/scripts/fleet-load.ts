/** Manual/release-only fleet safety gate. Never add this workload to push/PR CI. */
import { execFile, fork, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { seedCodex, startLinearFixture } from "./fleet-load-fixtures.ts";
import { startFleetLoadService, type FleetLoadServiceConfig } from "./fleet-load-service.ts";
import { installHerdrRelease } from "../src/herdr-release.ts";
import herdrPin from "../../../scripts/release/herdr.json" with { type: "json" };

const execute = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const runnerRoot = resolve(dirname(script), "../../..");
const args = process.argv.slice(2);
const argument = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
};
const numeric = (name: string, fallback: number, minimum: number) => {
  const value = Number(argument(name, String(fallback)));
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} must be at least ${minimum}`);
  return value;
};
const percentile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? null;
};
const average = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

interface Sample {
  at: number;
  cpuPercent: number;
  admissions: number;
  eventLoopP95Ms: number;
}
interface WorkerMetrics {
  pid: number;
  pane: string;
  session: string;
  ready: boolean;
  calls: Array<{ at: number; latencyMs: number }>;
  errors: Array<{ at: number; error: string }>;
}
interface Agent {
  paneId: string;
  terminalId?: string;
  session?: { kind: string; value: string };
  agent: string;
}

async function gate() {
  const sourceRoot = resolve(argument("--source-root", runnerRoot));
  const output = resolve(argument("--output", join(runnerRoot, ".data/qa/fleet-load.json")));
  const durationSeconds = numeric("--duration-seconds", 120, 15);
  const warmupSeconds = numeric("--warmup-seconds", 10, 1);
  const workers = numeric("--workers", 10, 1);
  if (!Number.isInteger(workers) || workers > 32)
    throw new Error("--workers must be an integer from 1 to 32");
  const largeMb = numeric("--large-session-mb", 32, 1);
  const budgets = {
    steadyCpuPercent: numeric("--cpu-budget-percent", 9.9, 0.01),
    healthP95Ms: numeric("--health-p95-ms", 250, 1),
    toolP95Ms: numeric("--tool-p95-ms", 2000, 1),
    admissionRefusals: 0,
    linearCallsPerMinute: numeric("--linear-calls-per-minute", 24, 1),
  };
  const root = await mkdtemp(join(tmpdir(), "cl-fl-"));
  const errors: string[] = [];
  const samples: Sample[] = [];
  const health: number[] = [];
  const fleet: number[] = [];
  const nativeCpu: number[] = [];
  let service: ChildProcess | undefined;
  let herdrProcess: ChildProcess | undefined;
  let provider: Awaited<ReturnType<typeof startLinearFixture>> | undefined;
  let fixture: Awaited<ReturnType<typeof seedCodex>> | undefined;
  let started = 0;
  let ended = 0;
  let sourceCommit = "unknown";
  let admissionRefusals = 0;
  const workerPaths: string[] = [];
  const logs: string[] = [];
  const abort = new AbortController();
  const signal = abort.signal;
  const stop = () => abort.abort(new Error("Fleet load interrupted"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const readWorker = async (path: string): Promise<WorkerMetrics | undefined> => {
    try {
      return JSON.parse(await readFile(path, "utf8")) as WorkerMetrics;
    } catch {
      return undefined;
    }
  };
  const loop = async (interval: number, work: () => Promise<void>) => {
    while (!signal.aborted && Date.now() < started + durationSeconds * 1000) {
      const at = Date.now();
      try {
        await work();
      } catch (error) {
        if (!signal.aborted) errors.push(String(error));
      }
      await sleep(Math.max(0, interval - (Date.now() - at)), undefined, { signal }).catch(() => {});
    }
  };
  try {
    if (process.platform !== "darwin")
      throw new Error(
        "Fleet OS admission load gate currently requires macOS; an unsupported host must not pass",
      );
    if (!existsSync(join(sourceRoot, "apps/clankie/node_modules")))
      throw new Error(
        `Install ${sourceRoot} with pnpm install --frozen-lockfile first (do not share node_modules)`,
      );
    sourceCommit = (await execute("git", ["rev-parse", "HEAD"], { cwd: sourceRoot })).stdout.trim();
    const proofBuild = join(sourceRoot, "scripts/build-fleet-proof.mjs");
    if (existsSync(proofBuild))
      await execute(process.execPath, [proofBuild], { cwd: sourceRoot, timeout: 60_000 });
    const herdr = resolve(argument("--herdr-binary", join(runnerRoot, ".data/herdr/bin/herdr")));
    if (!args.includes("--herdr-binary")) await installHerdrRelease(herdr, herdrPin.release);
    const socket = join(root, "herdr.sock");
    const workspace = join(root, "workspace");
    const codex = join(root, "codex-home");
    for (const directory of [
      workspace,
      join(root, "bin"),
      join(root, "xdg/herdr"),
      codex,
      join(root, "workers"),
      join(root, "state"),
      join(root, "home"),
    ])
      await mkdir(directory, { recursive: true });
    await copyFile(join(dirname(script), "fleet-load-worker.mjs"), join(root, "bin/codex"));
    await chmod(join(root, "bin/codex"), 0o700);
    await writeFile(
      join(root, "xdg/herdr/config.toml"),
      'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\n[update]\nversion_check = false\nmanifest_check = false\n',
    );
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      LANG: process.env.LANG ?? "en_US.UTF-8",
    };
    Object.assign(env, {
      PATH: `${join(root, "bin")}:${dirname(herdr)}:${process.env.PATH ?? ""}`,
      HOME: join(root, "home"),
      HERDR_SOCKET_PATH: socket,
      XDG_CONFIG_HOME: join(root, "xdg"),
      XDG_STATE_HOME: join(root, "xdg"),
      XDG_RUNTIME_DIR: join(root, "xdg"),
      CODEX_HOME: codex,
      CLANKIE_STATE: join(root, "state"),
      CLANKIE_STATE_HOME: join(root, "xdg"),
      CLANKIE_SETTINGS_FILE: join(root, "settings.json"),
      CLANKIE_CREDENTIALS_FILE: join(root, "credentials.json"),
    });
    await writeFile(
      join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 1,
        herdr: { runtime: "external", session: "default", socketPath: socket },
        fleet: { tools: "connected", peerMessages: "off" },
        projects: { projects: [] },
      }),
    );
    await mkdir(join(workspace, ".clankie"));
    await writeFile(
      join(workspace, ".clankie/tracking.json"),
      JSON.stringify({
        schemaVersion: 1,
        backend: "linear",
        linear: { team: "LOAD", project: "Fleet fixture" },
        decidedBy: "owner",
        decidedAt: new Date().toISOString(),
      }),
    );
    await execute("git", ["init", "--quiet", workspace]);
    fixture = await seedCodex(codex, workspace, workers, largeMb);
    herdrProcess = spawn(herdr, ["server"], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    herdrProcess.stdout?.on("data", (chunk) => logs.push(String(chunk)));
    herdrProcess.stderr?.on("data", (chunk) => logs.push(String(chunk)));
    const herdrRun = async (args: string[]) => {
      const { stdout } = await execute(herdr, args, { env, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
      return stdout.trim() ? JSON.parse(stdout) : undefined;
    };
    const deadline = Date.now() + 30_000;
    while (true) {
      try {
        await herdrRun(["api", "snapshot"]);
        break;
      } catch (error) {
        if (Date.now() >= deadline || herdrProcess.exitCode !== null)
          throw new Error(`Owned Herdr startup failed: ${String(error)} ${logs.join("").slice(-3000)}`);
        await sleep(200);
      }
    }
    provider = await startLinearFixture();
    const config: FleetLoadServiceConfig = {
      sourceRoot,
      root,
      workspace,
      socket,
      herdr,
      provider: provider.url,
      bearer: randomUUID(),
    };
    await writeFile(join(root, "service.json"), JSON.stringify(config));
    service = fork(script, ["--internal-service", join(root, "service.json")], {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    service.stdout?.on("data", (chunk) => logs.push(String(chunk)));
    service.stderr?.on("data", (chunk) => logs.push(String(chunk)));
    const ready = await new Promise<{ port: number; pid: number }>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Service startup timeout: ${logs.join("").slice(-5000)}`)),
        60_000,
      );
      service!.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Service exited ${code}: ${logs.join("").slice(-5000)}`));
      });
      service!.on("message", (message: unknown) => {
        const value = message as { kind?: string };
        if (value.kind === "ready") {
          clearTimeout(timeout);
          resolve(value as unknown as { port: number; pid: number });
        }
        if (value.kind === "sample") samples.push(value as Sample);
        if (value.kind === "admission") admissionRefusals = (value as unknown as { count: number }).count;
      });
    });
    const base = `http://127.0.0.1:${ready.port}`;
    const dispatch = async (
      body: Record<string, unknown>,
      requestSignal?: AbortSignal,
    ): Promise<Record<string, unknown>> => {
      const response = await fetch(`${base}/operator/v1/dispatch`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, ...body }),
        signal: requestSignal ?? AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Dispatch ${body.op} returned ${response.status}: ${text}`);
      return JSON.parse(text) as Record<string, unknown>;
    };
    const created = await herdrRun([
      "workspace",
      "create",
      "--cwd",
      workspace,
      "--label",
      "Fleet release gate",
      "--no-focus",
    ]);
    const pane = created.result.root_pane.pane_id as string;
    const panes = [pane];
    const bridge = join(sourceRoot, "integrations/claude-plugin/worker/bin/fleet-mcp.mjs");
    for (let index = 0; index < workers; index++) {
      if (index > 0) {
        const split = await herdrRun([
          "pane",
          "split",
          "--pane",
          pane,
          "--direction",
          index % 2 ? "down" : "right",
          "--cwd",
          workspace,
          "--no-focus",
        ]);
        panes.push(split.result.pane.pane_id as string);
      }
      const metrics = join(root, "workers", `${index}.json`);
      workerPaths.push(metrics);
      const command = [
        process.execPath,
        join(root, "bin/codex"),
        bridge,
        fixture.ids[index]!,
        metrics,
        "30000",
        String(Math.floor((index * 30_000) / workers)),
      ]
        .map(quote)
        .join(" ");
      await herdrRun(["pane", "run", panes[index]!, command]);
    }
    const parse = (await import(
      pathToFileURL(join(sourceRoot, "apps/clankie/src/captain/herdr-census.ts")).href
    )) as typeof import("../src/captain/herdr-census.ts");
    const workerDeadline = Date.now() + 60_000;
    let agents: readonly Agent[] = [];
    while (true) {
      const metrics = await Promise.all(workerPaths.map(readWorker));
      if (metrics.some((value) => value && !value.ready && value.errors.length))
        throw new Error(`Worker bridge startup failed: ${JSON.stringify(metrics)}`);
      agents = parse.parseHerdrAgentList(JSON.stringify(await herdrRun(["agent", "list"])));
      if (
        metrics.every((value) => value?.ready) &&
        agents.length === workers &&
        agents.every(
          (value) =>
            value.agent === "codex" && value.terminalId && fixture!.ids.includes(value.session?.value ?? ""),
        )
      )
        break;
      if (Date.now() >= workerDeadline)
        throw new Error(`Workers failed readiness: ${JSON.stringify({ metrics, agents })}`);
      await sleep(500);
    }
    for (const agent of agents)
      await dispatch({
        op: "create",
        scope: { kind: "seat", seatId: agent.terminalId },
        title: `Fixture ${agent.paneId}`,
      });
    const initial = await dispatch({ op: "fleet", includeWork: true });
    const fleetSnapshot = initial.snapshot as
      | { seats?: Array<{ harness?: string; subagents?: { running: number }; goal?: unknown }> }
      | undefined;
    // Coverage is a gate: a missing native transcript path cannot silently turn
    // the expensive fixture into an idle-roster benchmark.
    const snapshot = fleetSnapshot ?? initial;
    const json = JSON.stringify(snapshot);
    const addressed = fleetSnapshot?.seats?.filter((seat) => seat.harness === "codex") ?? [];
    if (
      addressed.length !== workers ||
      addressed.some((seat) => !seat.subagents || !seat.goal) ||
      !json.includes("Fixture child") ||
      !json.includes("authorized build")
    )
      throw new Error(`Fleet projection skipped native subagents or goals: ${json.slice(0, 4000)}`);
    const work = await dispatch({ op: "work_items", repoId: "workspace" });
    if (!JSON.stringify(work).includes("LOAD-1"))
      throw new Error(`Work panel did not read the controlled Linear issue: ${JSON.stringify(work)}`);
    await sleep(warmupSeconds * 1000, undefined, { signal });
    started = Date.now();
    service.send("measure");
    await writeFile(join(root, "workers", "start"), String(started));
    const finish = setTimeout(() => abort.abort(), durationSeconds * 1000);
    console.log(
      `Fleet load: ${workers} real bridges, ${durationSeconds}s measurement, source ${sourceCommit.slice(0, 8)}`,
    );
    let cursor: string | undefined;
    await Promise.all([
      loop(1000, async () => {
        const at = performance.now();
        const response = await fetch(`${base}/health`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        });
        const body = (await response.json()) as { ok?: boolean };
        if (!response.ok || body.ok !== true) throw new Error(`Health failed (${response.status})`);
        health.push(performance.now() - at);
      }),
      loop(1000, async () => {
        const at = performance.now();
        await dispatch(
          { op: "fleet", includeWork: true },
          AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        );
        fleet.push(performance.now() - at);
      }),
      loop(1, async () => {
        const result = await dispatch(
          { op: "fleet", includeWork: true, ...(cursor ? { cursor } : {}), waitMs: 20_000 },
          AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
        );
        const value = result.snapshot as { cursor?: string };
        cursor = value.cursor;
        if (!cursor) throw new Error("Fleet response omitted production long-poll cursor");
      }),
      loop(60_000, async () => {
        await dispatch(
          { op: "work_items", repoId: "workspace" },
          AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        );
      }),
      loop(1000, async () => {
        const output = (await execute("ps", ["-axo", "pid=,ppid=,%cpu="], { timeout: 5000 })).stdout;
        const rows = output
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/u).map(Number));
        const descendants = new Set<number>([ready.pid]);
        for (let changed = true; changed;) {
          changed = false;
          for (const [pid, parent] of rows)
            if (pid && parent && descendants.has(parent) && !descendants.has(pid)) {
              descendants.add(pid);
              changed = true;
            }
        }
        nativeCpu.push(
          rows.reduce(
            (sum, [pid, _parent, cpu]) =>
              sum + (pid && pid !== ready.pid && descendants.has(pid) ? (cpu ?? 0) : 0),
            0,
          ),
        );
      }),
    ]);
    clearTimeout(finish);
    ended = Date.now();
  } catch (error) {
    errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
    ended = Date.now();
  } finally {
    abort.abort();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    const workerMetrics = await Promise.all(workerPaths.map(readWorker));
    const tool = workerMetrics.flatMap(
      (worker) =>
        worker?.calls
          .filter((call) => call.at >= started && call.at <= ended)
          .map((call) => call.latencyMs) ?? [],
    );
    for (const worker of workerMetrics)
      for (const failure of worker?.errors ?? []) errors.push(`${worker!.pane}: ${failure.error}`);
    const elapsedSeconds = started ? (ended - started) / 1000 : 0;
    const measuredCalls =
      provider?.calls.filter((call) => started && call.at >= started && call.at <= ended) ?? [];
    const metrics = {
      elapsedSeconds,
      readyWorkers: workerMetrics.filter((value) => value?.ready).length,
      steadyCpuPercent: average(samples.map((sample) => sample.cpuPercent)),
      cpuP95Percent: percentile(
        samples.map((sample) => sample.cpuPercent),
        0.95,
      ),
      nativeDescendantCpuPercent: average(nativeCpu),
      healthP95Ms: percentile(health, 0.95),
      healthRequests: health.length,
      toolP95Ms: percentile(tool, 0.95),
      toolCalls: tool.length,
      fleetP95Ms: percentile(fleet, 0.95),
      fleetRequests: fleet.length,
      admissionRefusals: Math.max(admissionRefusals, ...samples.map((sample) => sample.admissions)),
      linearCalls: measuredCalls.length,
      linearCallsPerMinute: elapsedSeconds ? (measuredCalls.length / elapsedSeconds) * 60 : null,
      linearByTool: Object.fromEntries(
        [...new Set(measuredCalls.map((call) => call.tool))].map((tool) => [
          tool,
          measuredCalls.filter((call) => call.tool === tool).length,
        ]),
      ),
      eventLoopP95Ms: percentile(
        samples.map((sample) => sample.eventLoopP95Ms),
        0.95,
      ),
    };
    if (metrics.readyWorkers !== workers)
      errors.push(`Expected ${workers} ready worker bridges; found ${metrics.readyWorkers}`);
    if (elapsedSeconds < durationSeconds)
      errors.push(`Measurement incomplete: ${elapsedSeconds}s < ${durationSeconds}s`);
    for (const [key, actual, ceiling] of [
      ["steady CPU", metrics.steadyCpuPercent, budgets.steadyCpuPercent],
      ["health p95", metrics.healthP95Ms, budgets.healthP95Ms],
      ["tool p95", metrics.toolP95Ms, budgets.toolP95Ms],
      ["admission refusals", metrics.admissionRefusals, budgets.admissionRefusals],
      ["Linear calls/min", metrics.linearCallsPerMinute, budgets.linearCallsPerMinute],
    ] as const)
      if (actual === null || actual > ceiling)
        errors.push(`${key}: ${actual ?? "unmeasured"} exceeds budget ${ceiling}`);
    if (samples.length < Math.floor(durationSeconds * 0.8)) errors.push("Insufficient service CPU samples");
    if (!metrics.toolCalls || !metrics.fleetRequests || !metrics.healthRequests)
      errors.push("Workload did not exercise every required endpoint");
    const evidence = {
      schemaVersion: 1,
      outcome: errors.length ? "failed" : "passed",
      sourceRoot,
      sourceCommit,
      runnerRoot,
      recordedAt: new Date().toISOString(),
      budgets,
      workload: {
        workers,
        durationSeconds,
        warmupSeconds,
        fleetFreshReadMs: 1000,
        fleetLongPollMs: 20_000,
        catalogMs: 5000,
        mailboxMs: 25_000,
        workerToolMs: 30_000,
        workerToolPhase: "evenly staggered within the 30-second cadence",
        workPanelMs: 60_000,
        codex: fixture,
      },
      metrics,
      errors: [...new Set(errors)],
      samples,
      logs: logs.join("").slice(-8000),
    };
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
    console.log(
      JSON.stringify(
        { outcome: evidence.outcome, sourceCommit, output, metrics, errors: evidence.errors },
        null,
        2,
      ),
    );
    // Both groups were created by this invocation; isolated Herdr owns every
    // fixture pane. Never inspect, stop or close the owner's active server.
    const stopOwned = async (child: ChildProcess | undefined) => {
      if (!child?.pid || child.exitCode !== null) return;
      if (child.connected) child.send("stop");
      else child.kill("SIGTERM");
      await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), sleep(3000)]);
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* Already closed. */
      }
      await sleep(250);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already closed. */
      }
    };
    await stopOwned(service);
    await stopOwned(herdrProcess);
    await provider?.close();
    await rm(root, { recursive: true, force: true });
    process.exitCode = errors.length ? 1 : 0;
  }
}

if (args.includes("--help")) {
  console.log(
    "Fleet release safety gate (manual/release ONLY)\n  pnpm check:load [--source-root PATH] [--output PATH]\n  --duration-seconds 120 --warmup-seconds 10 --workers 10 --large-session-mb 32\n  --cpu-budget-percent 9.9 --health-p95-ms 250 --tool-p95-ms 2000 --linear-calls-per-minute 24\n  Requires macOS and a frozen real install in source-root; installs checksum-pinned official Herdr.\n  Shorter windows are development evidence; release uses the defaults.",
  );
} else if (args.includes("--internal-service")) {
  const config = JSON.parse(
    await readFile(argument("--internal-service", ""), "utf8"),
  ) as FleetLoadServiceConfig;
  await startFleetLoadService(config);
} else {
  await gate();
}
