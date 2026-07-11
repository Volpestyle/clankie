import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { SaplingApiClient } from "../packages/api-client/src/index.ts";
import { SqliteEventStore, projectMission } from "../packages/event-store/src/index.ts";
import { MissionPlanSchema, type DomainEvent } from "../packages/protocol/src/index.ts";
import type { TerminalFrame, TerminalSession } from "../packages/terminal-protocol/src/index.ts";
import { ProcessLeaseManager, type ProcessLease } from "../apps/runner/src/process-leases.ts";
import { TerminalManager, type TerminalTransport } from "../apps/runner/src/terminals.ts";
import type { ConsoleRecoverySnapshot, ConsoleTerminalSnapshot } from "../apps/tui/src/recovery-probe.ts";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");

interface CapturedProcess {
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
}

interface WorkerProcess {
  child: ChildProcessWithoutNullStreams;
  transport: ChildTransport;
  workerRunId: string;
  taskId: string;
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

interface ReplayServer {
  url: string;
  close(): Promise<void>;
}

class ChildTransport implements TerminalTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly dataListeners: Array<(chunk: Buffer) => void> = [];
  private readonly exitListeners: Array<(exitCode: number | null) => void> = [];
  private exited = false;
  private exitCode: number | null = null;

  public constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.emitData(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.emitData(chunk));
    child.on("exit", (code) => {
      if (this.exited) return;
      this.exited = true;
      this.exitCode = code;
      for (const listener of this.exitListeners) listener(code);
    });
  }

  public write(bytes: Uint8Array): void {
    this.child.stdin.write(bytes);
  }

  public resize(): void {
    // The drill uses pipe transports; resize is intentionally a no-op.
  }

  public kill(): void {
    this.child.kill("SIGKILL");
  }

  public onData(listener: (chunk: Buffer) => void): void {
    this.dataListeners.push(listener);
  }

  public onExit(listener: (exitCode: number | null) => void): void {
    this.exitListeners.push(listener);
    if (this.exited) queueMicrotask(() => listener(this.exitCode));
  }

  private emitData(chunk: Buffer): void {
    for (const listener of this.dataListeners) listener(chunk);
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function runWorker(): Promise<never> {
  const workerRunId = argument("--worker-run-id");
  assert(workerRunId, "worker role requires --worker-run-id");
  let sequence = 0;
  await delay(250);
  setInterval(() => {
    sequence += 1;
    process.stdout.write(`${workerRunId}:frame:${String(sequence).padStart(4, "0")}\n`);
  }, 75);
  return new Promise<never>(() => undefined);
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

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
  return port;
}

function startControlPlane(port: number, eventStorePath: string): CapturedProcess {
  return captureProcess("pnpm", ["--filter", "@sapling/control-plane", "start"], {
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      SAPLING_EVENT_STORE: eventStorePath,
      SAPLING_DOCTRINE: join(repoRoot, "doctrine/profiles/rawdog.yaml"),
    },
  });
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

function startWorker(workerRunId: string, taskId: string): WorkerProcess {
  const captured = captureProcess(process.execPath, [
    "--import",
    "tsx",
    scriptPath,
    "--role",
    "worker",
    "--worker-run-id",
    workerRunId,
  ]);
  return {
    child: captured.child,
    transport: new ChildTransport(captured.child),
    workerRunId,
    taskId,
  };
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

async function waitForTerminalSequence(
  manager: TerminalManager,
  terminalId: string,
  minimum: number,
  timeoutMs = 10_000,
): Promise<TerminalSession> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = (await manager.listSessions()).find((candidate) => candidate.id === terminalId);
    if (session && session.lastSequence >= minimum) return session;
    await delay(25);
  }
  throw new Error(`Terminal ${terminalId} did not reach sequence ${String(minimum)}`);
}

async function collectThrough(
  manager: TerminalManager,
  terminalId: string,
  throughSequence: number,
  fromSequence?: number,
): Promise<TerminalFrame[]> {
  const frames: TerminalFrame[] = [];
  for await (const frame of manager.observe(terminalId, fromSequence)) {
    frames.push(frame);
    if (frame.sequence >= throughSequence) break;
  }
  return frames;
}

async function readRequestBody(request: AsyncIterable<Uint8Array>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    length += bytes.byteLength;
    assert(length <= 16_384, "terminal replay request is too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function startReplayServer(manager: TerminalManager): Promise<ReplayServer> {
  const server: HttpServer = createHttpServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/replay") {
        response.writeHead(404).end();
        return;
      }
      const body = (await readRequestBody(request)) as { cursors?: Record<string, unknown> };
      const cursors = body.cursors ?? {};
      const sessions = [...(await manager.listSessions())].sort((left, right) =>
        left.workerRunId.localeCompare(right.workerRunId),
      );
      const terminals = await Promise.all(
        sessions.map(async (session) => {
          const rawCursor = cursors[session.id];
          assert(
            rawCursor === undefined || (Number.isInteger(rawCursor) && Number(rawCursor) >= 0),
            `invalid replay cursor for ${session.id}`,
          );
          const frames = await collectThrough(
            manager,
            session.id,
            session.lastSequence,
            rawCursor === undefined ? undefined : Number(rawCursor),
          );
          return {
            terminalId: session.id,
            workerRunId: session.workerRunId,
            throughSequence: session.lastSequence,
            frames,
          };
        }),
      );
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ terminals }));
    } catch (error) {
      response
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port.toString()}/replay`,
    close: () =>
      new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      ),
  };
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

async function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.signalCode || child.exitCode !== null) return;
  await once(child, "exit");
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

async function runDrill(): Promise<void> {
  const outputDir = resolve(argument("--output") ?? join(repoRoot, "artifacts/evals/m1-exit-gate"));
  await mkdir(outputDir, { recursive: true });
  const stateRoot = await mkdtemp(join(tmpdir(), "clankie-m1-exit-gate-"));
  const eventStorePath = join(stateRoot, "events.db");
  const sideEffectPath = join(stateRoot, "side-effect.json");
  const consoleBeforePath = join(stateRoot, "console-before.json");
  const consoleAfterPath = join(stateRoot, "console-after.json");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const terminalManager = new TerminalManager();
  const eventStore = new SqliteEventStore(eventStorePath);
  const leaseManager = new ProcessLeaseManager({ rootDir: stateRoot, events: eventStore });
  let replayServer: ReplayServer | undefined;
  const controls: CapturedProcess[] = [];
  const consoles: CapturedProcess[] = [];
  const workers: WorkerProcess[] = [];
  const leases: ProcessLease[] = [];

  try {
    const controlBefore = startControlPlane(port, eventStorePath);
    controls.push(controlBefore);
    const { profileHash } = await waitForHealth(baseUrl, 10_000, controlBefore);
    const client = new SaplingApiClient({ baseUrl });
    const { missionId } = await client.createMission({
      goal: "M1 crash recovery drill",
      context: { issue: "VUH-693", workers: 3 },
    });
    const taskIds = ["worker-a", "worker-b", "worker-c"];
    const plan = MissionPlanSchema.parse({
      missionId,
      goal: "M1 crash recovery drill",
      rationale: "Prove the trusted runner survives control-plane and console crashes.",
      profileHash,
      successCriteria: ["All three workers remain live and state recovers exactly."],
      tasks: taskIds.map((taskId) => ({
        id: taskId,
        title: `Run ${taskId}`,
        objective: "Continue producing terminal output across client-process crashes.",
        kind: "implementation" as const,
        role: "implementer" as const,
        executionClass: "runner_visible" as const,
        successCriteria: ["Worker stays live through reconnect."],
        evidenceRequirements: ["Lease and terminal replay evidence are attached."],
      })),
    });
    await client.proposePlan(missionId, plan);

    const sessions: TerminalSession[] = [];
    for (const [index, taskId] of taskIds.entries()) {
      const workerRunId = `run-${String(index + 1)}`;
      const worker = startWorker(workerRunId, taskId);
      workers.push(worker);
      assert(worker.child.pid);
      sessions.push(
        terminalManager.spawnTerminal({
          workerRunId,
          title: taskId,
          command: process.execPath,
          transport: worker.transport,
        }),
      );
      leases.push(
        await leaseManager.register({
          missionId,
          taskId,
          workerRunId,
          profileHash,
          pid: worker.child.pid,
        }),
      );
      await eventStore.append(
        event(
          `${missionId}:${taskId}:leased`,
          "task.leased",
          missionId,
          profileHash,
          {},
          taskId,
          workerRunId,
        ),
      );
      await eventStore.append(
        event(
          `${missionId}:${taskId}:running`,
          "task.running",
          missionId,
          profileHash,
          {},
          taskId,
          workerRunId,
        ),
      );
    }

    const readySessions: TerminalSession[] = [];
    for (const session of sessions) {
      readySessions.push(await waitForTerminalSequence(terminalManager, session.id, 3));
    }
    replayServer = await startReplayServer(terminalManager);
    const consoleBefore = startConsole({
      baseUrl,
      missionId,
      replayUrl: replayServer.url,
      output: consoleBeforePath,
    });
    consoles.push(consoleBefore);
    const consoleSnapshotBefore = await waitForFile<ConsoleRecoverySnapshot>(
      consoleBeforePath,
      10_000,
      consoleBefore,
    );
    assert.equal(consoleSnapshotBefore.client, "@sapling/tui recovery probe");
    const missionBefore = consoleSnapshotBefore.mission;
    for (const session of readySessions)
      assertWorkerStream(terminalSnapshot(consoleSnapshotBefore, session.id));

    const operationId = `${missionId}:side-effect:1`;
    assert.equal(await performSideEffect(sideEffectPath, operationId), "executed");
    const sideEffectEvent = event(operationId, "connector.side_effect.completed", missionId, profileHash, {
      operationId,
    });
    const firstSideEffectAppend = await eventStore.append(sideEffectEvent);
    const leasesBefore = stableLeases(await leaseManager.list());
    const eventsBefore = await eventStore.readAll();
    const projectionBefore = projectMission(
      eventsBefore.map((entry) => entry.event),
      missionId,
    );
    assert.equal(projectionBefore.state, "running");

    await Promise.all([killGroup(controlBefore), killChild(consoleBefore)]);
    assert.equal(controlBefore.child.signalCode, "SIGKILL");
    assert.equal(consoleBefore.child.signalCode, "SIGKILL");
    for (const worker of workers) {
      assert.equal(worker.child.exitCode, null);
      assert.equal(worker.child.signalCode, null);
      assert(worker.child.pid);
      process.kill(worker.child.pid, 0);
    }

    for (const session of readySessions) {
      const before = terminalSnapshot(consoleSnapshotBefore, session.id);
      assert(before.lastSequence >= session.lastSequence);
    }

    const postCrashSessions: TerminalSession[] = [];
    for (const session of readySessions) {
      const before = terminalSnapshot(consoleSnapshotBefore, session.id);
      postCrashSessions.push(
        await waitForTerminalSequence(terminalManager, session.id, before.lastSequence + 2),
      );
    }

    const controlAfter = startControlPlane(port, eventStorePath);
    controls.push(controlAfter);
    await waitForHealth(baseUrl, 10_000, controlAfter);
    const consoleAfter = startConsole({
      baseUrl,
      missionId,
      replayUrl: replayServer.url,
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

    const recoveredMission = await new SaplingApiClient({ baseUrl }).getMission(missionId);
    assert.deepEqual(recoveredMission, missionBefore);
    const leasesAfter = stableLeases(await leaseManager.list());
    assert.deepEqual(leasesAfter, leasesBefore);

    const terminalProofs: TerminalProof[] = [];
    for (const session of readySessions) {
      const recovered = postCrashSessions.find((candidate) => candidate.id === session.id);
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
    assert.deepEqual(eventsAfter, eventsBefore);
    assert.equal(eventsAfter.filter((entry) => entry.event.id === operationId).length, 1);
    const chain = await eventStore.verify();
    assert.deepEqual(chain, { valid: true, count: eventsAfter.length });
    const projectionAfter = projectMission(
      eventsAfter.map((entry) => entry.event),
      missionId,
    );
    assert.deepEqual(projectionAfter, projectionBefore);

    const report = {
      schemaVersion: 1,
      issue: "VUH-693",
      outcome: "pass",
      invocation: "pnpm exec tsx scripts/m1-exit-gate.ts",
      crash: {
        controlPlaneSignal: "SIGKILL",
        consoleSignal: "SIGKILL",
        consoleClient: "@sapling/tui --recovery-probe",
        consoleConsumedTerminalReplay: true,
        workersAliveDuringCrash: workers.length,
      },
      mission: {
        missionId,
        profileHash,
        state: projectionAfter.state,
        recordExact: true,
        projectionExact: true,
        eventLogExact: true,
        eventCount: eventsAfter.length,
        hashChainValid: chain.valid,
      },
      leases: leasesAfter.map((lease) => ({
        leaseId: lease.id,
        workerRunId: lease.workerRunId,
        taskId: lease.taskId,
        pid: lease.pid,
        processStartedAt: lease.processStartedAt,
        state: lease.state,
        exactAfterRecovery: true,
      })),
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
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await Promise.all(controls.map(killGroup));
    await Promise.all(consoles.map((consoleProcess) => killChild(consoleProcess)));
    for (const worker of workers) worker.transport.kill();
    await Promise.all(workers.map((worker) => waitForChildExit(worker.child)));
    for (const lease of leases) await leaseManager.complete(lease.id);
    await replayServer?.close();
    eventStore.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
}

const role = argument("--role");
if (role === "worker") await runWorker();
else await runDrill();
