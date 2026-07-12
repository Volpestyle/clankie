import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { RunnerRecoveryStatus } from "../apps/runner/src/recovery-probe.ts";
import { ProcessLeaseManager, type ProcessLease } from "../apps/runner/src/process-leases.ts";
import type { ConsoleRecoverySnapshot, ConsoleTerminalSnapshot } from "../apps/tui/src/recovery-probe.ts";
import { ClankieApiClient } from "../packages/api-client/src/index.ts";
import { SqliteEventStore, projectMission } from "../packages/event-store/src/index.ts";
import { MissionPlanSchema, type DomainEvent } from "../packages/protocol/src/index.ts";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");

interface CapturedProcess {
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
}

interface TerminalProof {
  terminalId: string;
  workerRunId: string;
  preCrashSequence: number;
  recoveredSequence: number;
  resumedFirstSequence: number;
  replayedBytes: number;
  gapFree: true;
  byteExact: true;
}

interface LeaseProof {
  leaseId: string;
  workerRunId: string;
  taskId: string;
  pid: number;
  processStartedAt: string;
  previousRunnerPid: number;
  recoveredRunnerPid: number;
  state: "live";
  identityExact: true;
  readopted: true;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function captureProcess(
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2] = {},
): CapturedProcess {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: process.env,
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  return { child, stdout, stderr };
}

async function freePorts(count: number): Promise<number[]> {
  const servers = Array.from({ length: count }, () => createNetServer());
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolvePromise, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolvePromise);
        }),
    ),
  );
  const ports = servers.map((server) => {
    const address = server.address();
    assert(address && typeof address === "object");
    return address.port;
  });
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolvePromise, reject) =>
          server.close((error) => (error ? reject(error) : resolvePromise())),
        ),
    ),
  );
  return ports;
}

function startControlPlane(port: number, eventStorePath: string): CapturedProcess {
  return captureProcess("pnpm", ["--filter", "@clankie/control-plane", "start"], {
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      CLANKIE_EVENT_STORE: eventStorePath,
      CLANKIE_DOCTRINE: join(repoRoot, "doctrine/profiles/rawdog.yaml"),
    },
  });
}

function startRunner(options: {
  stateRoot: string;
  eventStorePath: string;
  missionId: string;
  profileHash: string;
  port: number;
  output: string;
}): CapturedProcess {
  return captureProcess(
    process.execPath,
    [
      "--import",
      "tsx",
      join(repoRoot, "apps/runner/src/index.ts"),
      "--recovery-probe",
      "--state-root",
      options.stateRoot,
      "--event-store",
      options.eventStorePath,
      "--mission-id",
      options.missionId,
      "--profile-hash",
      options.profileHash,
      "--port",
      options.port.toString(),
      "--output",
      options.output,
    ],
    { detached: true },
  );
}

function startConsole(options: {
  baseUrl: string;
  missionId: string;
  replayUrl: string;
  output: string;
  resumeFrom?: string;
}): CapturedProcess {
  return captureProcess(process.execPath, [
    "--import",
    "tsx",
    join(repoRoot, "apps/tui/src/index.ts"),
    "--recovery-probe",
    "--base-url",
    options.baseUrl,
    "--mission-id",
    options.missionId,
    "--replay-url",
    options.replayUrl,
    "--output",
    options.output,
    ...(options.resumeFrom === undefined ? [] : ["--resume-from", options.resumeFrom]),
  ]);
}

async function waitForHealth(
  baseUrl: string,
  timeoutMs = 10_000,
  processInfo?: CapturedProcess,
): Promise<{ profileHash: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/health", baseUrl));
      if (response.ok) return (await response.json()) as { profileHash: string };
    } catch {
      // Process startup and crash recovery both pass through connection refusal.
    }
    await delay(50);
  }
  const logs = processInfo
    ? `\nstdout:\n${processInfo.stdout.join("")}\nstderr:\n${processInfo.stderr.join("")}`
    : "";
  throw new Error(`Control plane did not become healthy at ${baseUrl}${logs}`);
}

async function waitForFile<T>(path: string, timeoutMs = 10_000, processInfo?: CapturedProcess): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
      await delay(50);
    }
  }
  const logs = processInfo
    ? `\nstdout:\n${processInfo.stdout.join("")}\nstderr:\n${processInfo.stderr.join("")}`
    : "";
  throw new Error(`Timed out waiting for ${path}${logs}`);
}

function terminalSnapshot(snapshot: ConsoleRecoverySnapshot, terminalId: string): ConsoleTerminalSnapshot {
  const terminal = snapshot.terminals.find((candidate) => candidate.terminalId === terminalId);
  assert(terminal, `TUI checkpoint omitted terminal ${terminalId}`);
  return terminal;
}

function assertWorkerStream(terminal: ConsoleTerminalSnapshot): void {
  const lines = Buffer.from(terminal.bytes, "base64").toString("utf8").trim().split("\n");
  assert(lines.length > 0, `TUI checkpoint has no output for ${terminal.workerRunId}`);
  assert.deepEqual(
    lines,
    lines.map((_, index) => `${terminal.workerRunId}:frame:${String(index + 1).padStart(4, "0")}`),
  );
}

async function waitForWorkerLogSequence(path: string, minimum: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const content = await readFile(path, "utf8");
    const sequence = content.match(/\n/g)?.length ?? 0;
    if (sequence >= minimum) return;
    await delay(25);
  }
  throw new Error(`Worker log ${path} did not reach sequence ${minimum.toString()}`);
}

function event(
  id: string,
  type: string,
  missionId: string,
  profileHash: string,
  data: Record<string, unknown>,
  taskId?: string,
  workerRunId?: string,
): DomainEvent {
  return {
    id,
    occurredAt: new Date().toISOString(),
    missionId,
    correlationId: missionId,
    profileHash,
    type,
    data,
    ...(taskId ? { taskId } : {}),
    ...(workerRunId ? { workerRunId } : {}),
  };
}

function stableLeases(leases: readonly ProcessLease[]): ProcessLease[] {
  return [...leases].sort((left, right) => left.workerRunId.localeCompare(right.workerRunId));
}

function leaseIdentity(lease: ProcessLease): Omit<ProcessLease, "runnerPid"> {
  const { runnerPid: _runnerPid, ...identity } = lease;
  return identity;
}

function projectionIdentity(
  projection: ReturnType<typeof projectMission>,
): Omit<ReturnType<typeof projectMission>, "eventCount"> {
  const { eventCount: _eventCount, ...identity } = projection;
  return identity;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function killGroup(processInfo: CapturedProcess): Promise<void> {
  const pid = processInfo.child.pid;
  if (!pid || processInfo.child.signalCode || processInfo.child.exitCode !== null) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await once(processInfo.child, "exit").catch(() => undefined);
}

async function killChild(processInfo: CapturedProcess | undefined): Promise<void> {
  if (!processInfo || processInfo.child.signalCode || processInfo.child.exitCode !== null) return;
  processInfo.child.kill("SIGKILL");
  await once(processInfo.child, "exit").catch(() => undefined);
}

async function killWorker(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && isAlive(pid)) await delay(25);
  assert(!isAlive(pid), `Worker pid ${pid.toString()} survived cleanup`);
}

async function discoverWorkerPids(stateRoot: string): Promise<number[]> {
  const workerRoot = join(stateRoot, "workers");
  const files = await readdir(workerRoot).catch(() => []);
  const pids: number[] = [];
  for (const file of files.filter((candidate) => candidate.endsWith(".pid"))) {
    const value = await readFile(join(workerRoot, file), "utf8");
    const pid = Number.parseInt(value, 10);
    assert(Number.isInteger(pid) && pid > 0, `Invalid worker pid marker ${file}`);
    pids.push(pid);
  }
  return pids;
}

async function performSideEffect(path: string, operationId: string): Promise<"executed" | "replayed"> {
  const content = `${JSON.stringify({ operationId, result: "accepted" }, null, 2)}\n`;
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    return "executed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    assert.equal(await readFile(path, "utf8"), content);
    return "replayed";
  }
}

function scrub(value: unknown, stateRoot: string): string {
  return `${JSON.stringify(value, null, 2).replaceAll(stateRoot, "<state-root>")}\n`;
}

async function runDrill(): Promise<void> {
  const outputDir = resolve(argument("--output") ?? join(repoRoot, "artifacts/evals/m1-exit-gate"));
  await mkdir(outputDir, { recursive: true });
  const stateRoot = await mkdtemp(join(tmpdir(), "clankie-m1-exit-gate-"));
  const eventStorePath = join(stateRoot, "events.db");
  const sideEffectPath = join(stateRoot, "side-effect.json");
  const consoleBeforePath = join(stateRoot, "console-before.json");
  const consoleAfterPath = join(stateRoot, "console-after.json");
  const runnerBeforePath = join(stateRoot, "runner-before.json");
  const runnerAfterPath = join(stateRoot, "runner-after.json");
  const [controlPort, runnerPort] = await freePorts(2);
  const baseUrl = `http://127.0.0.1:${controlPort.toString()}`;
  const replayUrl = `http://127.0.0.1:${runnerPort.toString()}/replay`;
  const eventStore = new SqliteEventStore(eventStorePath);
  const controls: CapturedProcess[] = [];
  const runners: CapturedProcess[] = [];
  const consoles: CapturedProcess[] = [];
  let runnerStatus: RunnerRecoveryStatus | undefined;

  try {
    const controlBefore = startControlPlane(controlPort, eventStorePath);
    controls.push(controlBefore);
    const { profileHash } = await waitForHealth(baseUrl, 10_000, controlBefore);
    const client = new ClankieApiClient({ baseUrl });
    const { missionId } = await client.createMission({
      goal: "M1 crash recovery drill",
      context: { issue: "VUH-693", workers: 3 },
    });
    const taskIds = ["worker-a", "worker-b", "worker-c"];
    const plan = MissionPlanSchema.parse({
      missionId,
      goal: "M1 crash recovery drill",
      rationale: "Prove exact recovery after control-plane, runner, and TUI crashes.",
      profileHash,
      successCriteria: ["All three workers remain live and state recovers exactly."],
      tasks: taskIds.map((taskId) => ({
        id: taskId,
        title: `Run ${taskId}`,
        objective: "Continue producing terminal output while trusted client processes restart.",
        kind: "implementation" as const,
        role: "implementer" as const,
        executionClass: "runner_visible" as const,
        successCriteria: ["Worker stays live through runner re-adoption."],
        evidenceRequirements: ["Lease identity and terminal replay evidence are attached."],
      })),
    });
    await client.proposePlan(missionId, plan);

    const runnerBefore = startRunner({
      stateRoot,
      eventStorePath,
      missionId,
      profileHash,
      port: runnerPort,
      output: runnerBeforePath,
    });
    runners.push(runnerBefore);
    const runnerSnapshotBefore = await waitForFile<RunnerRecoveryStatus>(
      runnerBeforePath,
      10_000,
      runnerBefore,
    );
    runnerStatus = runnerSnapshotBefore;
    assert.equal(runnerSnapshotBefore.client, "@clankie/runner recovery probe");
    assert.equal(runnerSnapshotBefore.startOrdinal, 1);
    assert.equal(runnerSnapshotBefore.manifest.workers.length, 3);
    assert.equal(runnerSnapshotBefore.reconciliation.readopted.length, 0);

    for (const worker of runnerSnapshotBefore.manifest.workers) {
      assert(isAlive(worker.pid), `Worker ${worker.workerRunId} did not remain live`);
      await eventStore.append(
        event(
          `${missionId}:${worker.taskId}:leased`,
          "task.leased",
          missionId,
          profileHash,
          {},
          worker.taskId,
          worker.workerRunId,
        ),
      );
      await eventStore.append(
        event(
          `${missionId}:${worker.taskId}:running`,
          "task.running",
          missionId,
          profileHash,
          {},
          worker.taskId,
          worker.workerRunId,
        ),
      );
    }

    const consoleBefore = startConsole({
      baseUrl,
      missionId,
      replayUrl,
      output: consoleBeforePath,
    });
    consoles.push(consoleBefore);
    const consoleSnapshotBefore = await waitForFile<ConsoleRecoverySnapshot>(
      consoleBeforePath,
      10_000,
      consoleBefore,
    );
    assert.equal(consoleSnapshotBefore.client, "@clankie/tui recovery probe");
    const missionBefore = consoleSnapshotBefore.mission;
    for (const session of runnerSnapshotBefore.terminals) {
      assertWorkerStream(terminalSnapshot(consoleSnapshotBefore, session.id));
    }

    const operationId = `${missionId}:side-effect:1`;
    assert.equal(await performSideEffect(sideEffectPath, operationId), "executed");
    const sideEffectEvent = event(operationId, "connector.side_effect.completed", missionId, profileHash, {
      operationId,
    });
    const firstSideEffectAppend = await eventStore.append(sideEffectEvent);
    const leasesBefore = stableLeases(runnerSnapshotBefore.leases);
    const eventsBefore = await eventStore.readAll();
    const projectionBefore = projectMission(
      eventsBefore.map((entry) => entry.event),
      missionId,
    );
    assert.equal(projectionBefore.state, "running");

    await Promise.all([killGroup(controlBefore), killGroup(runnerBefore), killChild(consoleBefore)]);
    assert.equal(controlBefore.child.signalCode, "SIGKILL");
    assert.equal(runnerBefore.child.signalCode, "SIGKILL");
    assert.equal(consoleBefore.child.signalCode, "SIGKILL");
    for (const worker of runnerSnapshotBefore.manifest.workers) {
      assert(isAlive(worker.pid), `Worker ${worker.workerRunId} died with the runner`);
      const before = terminalSnapshot(consoleSnapshotBefore, worker.terminalId);
      await waitForWorkerLogSequence(worker.logPath, before.lastSequence + 2);
    }

    const controlAfter = startControlPlane(controlPort, eventStorePath);
    controls.push(controlAfter);
    await waitForHealth(baseUrl, 10_000, controlAfter);
    const runnerAfter = startRunner({
      stateRoot,
      eventStorePath,
      missionId,
      profileHash,
      port: runnerPort,
      output: runnerAfterPath,
    });
    runners.push(runnerAfter);
    const runnerSnapshotAfter = await waitForFile<RunnerRecoveryStatus>(runnerAfterPath, 10_000, runnerAfter);
    runnerStatus = runnerSnapshotAfter;
    assert.equal(runnerSnapshotAfter.startOrdinal, 2);
    assert.notEqual(runnerSnapshotAfter.runnerPid, runnerSnapshotBefore.runnerPid);
    assert.deepEqual(runnerSnapshotAfter.manifest, runnerSnapshotBefore.manifest);
    assert.equal(runnerSnapshotAfter.reconciliation.readopted.length, 3);
    assert.equal(runnerSnapshotAfter.reconciliation.failed.length, 0);
    assert.equal(runnerSnapshotAfter.reconciliation.retained.length, 0);

    const leasesAfter = stableLeases(runnerSnapshotAfter.leases);
    assert.equal(leasesAfter.length, leasesBefore.length);
    const leaseProofs: LeaseProof[] = leasesBefore.map((before, index) => {
      const after = leasesAfter[index];
      assert(after);
      assert.deepEqual(leaseIdentity(after), leaseIdentity(before));
      assert.equal(before.runnerPid, runnerSnapshotBefore.runnerPid);
      assert.equal(after.runnerPid, runnerSnapshotAfter.runnerPid);
      assert(
        runnerSnapshotAfter.reconciliation.readopted.some(
          (lease) => lease.id === before.id && lease.workerRunId === before.workerRunId,
        ),
      );
      assert.equal(after.state, "live");
      return {
        leaseId: after.id,
        workerRunId: after.workerRunId,
        taskId: after.taskId,
        pid: after.pid,
        processStartedAt: after.processStartedAt,
        previousRunnerPid: before.runnerPid,
        recoveredRunnerPid: after.runnerPid,
        state: "live",
        identityExact: true,
        readopted: true,
      };
    });

    const consoleAfter = startConsole({
      baseUrl,
      missionId,
      replayUrl,
      output: consoleAfterPath,
      resumeFrom: consoleBeforePath,
    });
    consoles.push(consoleAfter);
    const consoleSnapshotAfter = await waitForFile<ConsoleRecoverySnapshot>(
      consoleAfterPath,
      10_000,
      consoleAfter,
    );
    const missionAfter = consoleSnapshotAfter.mission;
    assert.deepEqual(missionAfter, missionBefore);
    assert.deepEqual(await new ClankieApiClient({ baseUrl }).getMission(missionId), missionBefore);

    const terminalProofs: TerminalProof[] = [];
    for (const session of runnerSnapshotBefore.terminals) {
      const recovered = runnerSnapshotAfter.terminals.find((candidate) => candidate.id === session.id);
      assert(recovered);
      assert.equal(recovered.workerRunId, session.workerRunId);
      const before = terminalSnapshot(consoleSnapshotBefore, session.id);
      const after = terminalSnapshot(consoleSnapshotAfter, session.id);
      assert.equal(after.resumedFromSequence, before.lastSequence);
      assert.equal(after.receivedSequences[0], before.lastSequence + 1);
      assert.deepEqual(
        after.receivedSequences,
        after.receivedSequences.map((_, index) => before.lastSequence + index + 1),
      );
      const beforeBytes = Buffer.from(before.bytes, "base64");
      const afterBytes = Buffer.from(after.bytes, "base64");
      assert.deepEqual(afterBytes.subarray(0, beforeBytes.byteLength), beforeBytes);
      assertWorkerStream(after);
      terminalProofs.push({
        terminalId: session.id,
        workerRunId: session.workerRunId,
        preCrashSequence: before.lastSequence,
        recoveredSequence: after.lastSequence,
        resumedFirstSequence: after.receivedSequences[0] ?? 0,
        replayedBytes: afterBytes.byteLength,
        gapFree: true,
        byteExact: true,
      });
    }

    assert.equal(await performSideEffect(sideEffectPath, operationId), "replayed");
    const replayedSideEffectAppend = await eventStore.append(sideEffectEvent);
    assert.equal(replayedSideEffectAppend.sequence, firstSideEffectAppend.sequence);
    const eventsAfter = await eventStore.readAll();
    assert.deepEqual(eventsAfter.slice(0, eventsBefore.length), eventsBefore);
    const recoveryEvents = eventsAfter.slice(eventsBefore.length);
    assert.equal(recoveryEvents.length, 3);
    assert(recoveryEvents.every((entry) => entry.event.type === "worker.readopted"));
    assert.deepEqual(recoveryEvents.map((entry) => entry.event.workerRunId).sort(), [
      "run-1",
      "run-2",
      "run-3",
    ]);
    assert.equal(eventsAfter.filter((entry) => entry.event.id === operationId).length, 1);
    assert.equal(new Set(eventsAfter.map((entry) => entry.event.id)).size, eventsAfter.length);
    const chain = await eventStore.verify();
    assert.deepEqual(chain, { valid: true, count: eventsAfter.length });
    const projectionAfter = projectMission(
      eventsAfter.map((entry) => entry.event),
      missionId,
    );
    assert.deepEqual(projectionIdentity(projectionAfter), projectionIdentity(projectionBefore));
    assert.equal(projectionAfter.eventCount, projectionBefore.eventCount + recoveryEvents.length);

    const report = {
      schemaVersion: 2,
      issue: "VUH-693",
      outcome: "pass",
      invocation: "pnpm exec tsx scripts/m1-exit-gate.ts",
      crash: {
        controlPlaneSignal: "SIGKILL",
        runnerSignal: "SIGKILL",
        consoleSignal: "SIGKILL",
        runnerClient: "@clankie/runner --recovery-probe",
        consoleClient: "@clankie/tui --recovery-probe",
        consoleConsumedTerminalReplay: true,
        workersAliveDuringCrash: runnerSnapshotBefore.manifest.workers.length,
      },
      runner: {
        previousPid: runnerSnapshotBefore.runnerPid,
        recoveredPid: runnerSnapshotAfter.runnerPid,
        previousStartOrdinal: runnerSnapshotBefore.startOrdinal,
        recoveredStartOrdinal: runnerSnapshotAfter.startOrdinal,
        readoptedWorkers: runnerSnapshotAfter.reconciliation.readopted.length,
        lostWorkers: runnerSnapshotAfter.reconciliation.failed.length,
        duplicateWorkers: 0,
      },
      mission: {
        missionId,
        profileHash,
        state: projectionAfter.state,
        recordExact: true,
        operationalProjectionExact: true,
        eventLogPrefixExact: true,
        recoveryEventCount: recoveryEvents.length,
        eventCount: eventsAfter.length,
        hashChainValid: chain.valid,
      },
      leases: leaseProofs,
      terminals: terminalProofs,
      sideEffects: {
        operationId,
        attempts: 2,
        executions: 1,
        eventOccurrences: 1,
        idempotentSequence: firstSideEffectAppend.sequence,
      },
    };
    await writeFile(join(outputDir, "01-drill-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(
      join(outputDir, "02-events.jsonl"),
      `${eventsAfter.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
    await writeFile(
      join(outputDir, "03-console-before.json"),
      `${JSON.stringify(consoleSnapshotBefore, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(outputDir, "04-console-after.json"),
      `${JSON.stringify(consoleSnapshotAfter, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(outputDir, "05-control-plane-before.log"),
      controlBefore.stdout.join("").replaceAll(stateRoot, "<state-root>"),
      "utf8",
    );
    await writeFile(
      join(outputDir, "06-control-plane-after.log"),
      controlAfter.stdout.join("").replaceAll(stateRoot, "<state-root>"),
      "utf8",
    );
    await writeFile(join(outputDir, "07-runner-before.json"), scrub(runnerSnapshotBefore, stateRoot), "utf8");
    await writeFile(join(outputDir, "08-runner-after.json"), scrub(runnerSnapshotAfter, stateRoot), "utf8");
    await writeFile(
      join(outputDir, "09-runner-before.log"),
      runnerBefore.stdout.join("").replaceAll(stateRoot, "<state-root>"),
      "utf8",
    );
    await writeFile(
      join(outputDir, "10-runner-after.log"),
      runnerAfter.stdout.join("").replaceAll(stateRoot, "<state-root>"),
      "utf8",
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await Promise.all(controls.map(killGroup));
    await Promise.all(runners.map(killGroup));
    await Promise.all(consoles.map((consoleProcess) => killChild(consoleProcess)));
    const manifest =
      runnerStatus?.manifest ??
      (await waitForFile<RunnerRecoveryStatus["manifest"]>(
        join(stateRoot, "runner-manifest.json"),
        250,
      ).catch(() => undefined));
    const workerPids = new Set([
      ...(manifest?.workers.map((worker) => worker.pid) ?? []),
      ...(await discoverWorkerPids(stateRoot)),
    ]);
    await Promise.all([...workerPids].map(killWorker));
    const cleanupLeases = new ProcessLeaseManager({ rootDir: stateRoot, events: eventStore });
    for (const lease of await cleanupLeases.list()) await cleanupLeases.complete(lease.id);
    eventStore.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
}

await runDrill();
