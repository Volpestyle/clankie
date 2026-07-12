import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SqliteEventStore } from "@clankie/event-store";
import type { TerminalFrame, TerminalSession } from "@clankie/terminal-protocol";
import { ProcessLeaseManager, type ProcessLease, type ReconcileProcessReport } from "./process-leases.ts";
import { TerminalManager, type TerminalTransport } from "./terminals.ts";

const workerProgram = `
import { writeFileSync } from "node:fs";
const workerRunId = process.argv[1];
const pidPath = process.argv[2];
writeFileSync(pidPath, String(process.pid) + "\\n", { flag: "wx" });
let sequence = 0;
setInterval(() => {
  sequence += 1;
  process.stdout.write(workerRunId + ":frame:" + String(sequence).padStart(4, "0") + "\\n");
}, 75);
`;

export interface RecoveryWorker {
  workerRunId: string;
  taskId: string;
  pid: number;
  leaseId: string;
  terminalId: string;
  logPath: string;
}

export interface RecoveryManifest {
  schemaVersion: 1;
  missionId: string;
  profileHash: string;
  workers: RecoveryWorker[];
}

export interface RunnerRecoveryStatus {
  schemaVersion: 1;
  client: "@clankie/runner recovery probe";
  runnerPid: number;
  startOrdinal: number;
  replayUrl: string;
  manifest: RecoveryManifest;
  leases: ProcessLease[];
  reconciliation: ReconcileProcessReport;
  terminals: TerminalSession[];
}

interface RecoveryProbeOptions {
  stateRoot: string;
  eventStorePath: string;
  missionId: string;
  profileHash: string;
  port: number;
  outputPath: string;
}

class DurableLogTransport implements TerminalTransport {
  private readonly logPath: string;
  private readonly pid: number;
  private dataListener: ((chunk: Buffer) => void) | undefined;
  private exitListener: ((exitCode: number | null) => void) | undefined;
  private offset = 0;
  private pending = Buffer.alloc(0);
  private pumping = false;
  private exited = false;

  public constructor(logPath: string, pid: number) {
    this.logPath = resolve(logPath);
    this.pid = pid;
    setInterval(() => void this.poll(), 20);
  }

  public write(): void {
    throw new Error("The recovery probe exposes observation only");
  }

  public resize(): void {
    // Durable line logs have no terminal geometry.
  }

  public kill(): void {
    try {
      process.kill(this.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  public onData(listener: (chunk: Buffer) => void): void {
    this.dataListener = listener;
    void this.poll();
  }

  public onExit(listener: (exitCode: number | null) => void): void {
    this.exitListener = listener;
  }

  private async poll(): Promise<void> {
    if (this.pumping || this.exited) return;
    this.pumping = true;
    try {
      const content = await readFile(this.logPath);
      assert(content.byteLength >= this.offset, `Worker log ${this.logPath} was truncated`);
      if (content.byteLength > this.offset) {
        const appended = content.subarray(this.offset);
        this.offset = content.byteLength;
        this.pending = Buffer.concat([this.pending, appended]);
        while (true) {
          const newline = this.pending.indexOf(0x0a);
          if (newline < 0) break;
          const line = this.pending.subarray(0, newline + 1);
          this.pending = this.pending.subarray(newline + 1);
          this.dataListener?.(line);
        }
      }
      if (!processIsAlive(this.pid)) {
        this.exited = true;
        this.exitListener?.(null);
      }
    } finally {
      this.pumping = false;
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid.toString()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function nextStartOrdinal(stateRoot: string): Promise<number> {
  const path = join(stateRoot, "runner-start-count");
  const previous = await readFile(path, "utf8").catch(() => "0");
  const next = Number.parseInt(previous, 10) + 1;
  assert(Number.isSafeInteger(next) && next > 0, "Invalid runner start counter");
  await writeFile(path, `${next.toString()}\n`, "utf8");
  return next;
}

async function spawnWorkers(
  options: RecoveryProbeOptions,
  leases: ProcessLeaseManager,
): Promise<RecoveryManifest> {
  const workerRoot = join(options.stateRoot, "workers");
  await mkdir(workerRoot, { recursive: true });
  const workers: RecoveryWorker[] = [];
  for (let index = 0; index < 3; index += 1) {
    const workerRunId = `run-${(index + 1).toString()}`;
    const taskId = `worker-${String.fromCharCode(97 + index)}`;
    const logPath = join(workerRoot, `${workerRunId}.log`);
    const pidPath = join(workerRoot, `${workerRunId}.pid`);
    await writeFile(logPath, "", { encoding: "utf8", flag: "wx" });
    const descriptor = openSync(logPath, "a");
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", workerProgram, workerRunId, pidPath],
      {
        detached: true,
        stdio: ["ignore", descriptor, descriptor],
      },
    );
    closeSync(descriptor);
    assert(child.pid, `Worker ${workerRunId} did not start`);
    child.unref();
    const persistedPid = await waitForPidMarker(pidPath);
    assert.equal(persistedPid, child.pid, `Worker ${workerRunId} persisted another pid`);
    const lease = await leases.register({
      missionId: options.missionId,
      taskId,
      workerRunId,
      profileHash: options.profileHash,
      pid: child.pid,
    });
    workers.push({
      workerRunId,
      taskId,
      pid: child.pid,
      leaseId: lease.id,
      terminalId: `terminal-${workerRunId}`,
      logPath,
    });
  }
  return {
    schemaVersion: 1,
    missionId: options.missionId,
    profileHash: options.profileHash,
    workers,
  };
}

async function waitForPidMarker(path: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await readFile(path, "utf8").catch(() => undefined);
    if (value !== undefined) {
      const pid = Number.parseInt(value, 10);
      assert(Number.isInteger(pid) && pid > 0, `Invalid worker pid marker ${path}`);
      return pid;
    }
    await delay(10);
  }
  throw new Error(`Worker did not persist pid marker ${path}`);
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

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    length += bytes.byteLength;
    assert(length <= 16_384, "Terminal replay request is too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response
    .writeHead(status, { "content-type": "application/json", connection: "close" })
    .end(JSON.stringify(value));
}

async function waitForTerminalSequence(
  manager: TerminalManager,
  terminalId: string,
  minimum: number,
): Promise<TerminalSession> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const session = (await manager.listSessions()).find((candidate) => candidate.id === terminalId);
    if (session && session.lastSequence >= minimum) return session;
    await delay(20);
  }
  throw new Error(`Terminal ${terminalId} did not reach sequence ${minimum.toString()}`);
}

async function startReplayServer(port: number, manager: TerminalManager): Promise<{ replayUrl: string }> {
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, { status: "ok", pid: process.pid });
        return;
      }
      if (request.method !== "POST" || request.url !== "/replay") {
        response.writeHead(404, { connection: "close" }).end();
        return;
      }
      const body = (await readRequestBody(request)) as { cursors?: Record<string, unknown> };
      assert(body && typeof body === "object", "Replay request must be an object");
      const cursors = body.cursors ?? {};
      assert(cursors && typeof cursors === "object", "Replay cursors must be an object");
      const sessions = [...(await manager.listSessions())].sort((left, right) =>
        left.workerRunId.localeCompare(right.workerRunId),
      );
      const terminals = await Promise.all(
        sessions.map(async (session) => {
          const rawCursor = cursors[session.id];
          assert(
            rawCursor === undefined || (Number.isInteger(rawCursor) && Number(rawCursor) >= 0),
            `Invalid replay cursor for ${session.id}`,
          );
          return {
            terminalId: session.id,
            workerRunId: session.workerRunId,
            throughSequence: session.lastSequence,
            frames: await collectThrough(
              manager,
              session.id,
              session.lastSequence,
              rawCursor === undefined ? undefined : Number(rawCursor),
            ),
          };
        }),
      );
      sendJson(response, 200, { terminals });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolvePromise);
  });
  return { replayUrl: `http://127.0.0.1:${port.toString()}/replay` };
}

export async function runRecoveryProbe(options: RecoveryProbeOptions): Promise<never> {
  await mkdir(options.stateRoot, { recursive: true });
  const eventStore = new SqliteEventStore(options.eventStorePath);
  const leaseManager = new ProcessLeaseManager({ rootDir: options.stateRoot, events: eventStore });
  const manifestPath = join(options.stateRoot, "runner-manifest.json");
  let manifest = await readJson<RecoveryManifest>(manifestPath);
  let reconciliation: ReconcileProcessReport = {
    readopted: [],
    failed: [],
    retained: [],
    resumedCancels: [],
    corruptRemoved: [],
  };
  if (manifest === undefined) {
    manifest = await spawnWorkers(options, leaseManager);
    await writeJsonAtomic(manifestPath, manifest);
  } else {
    assert.equal(manifest.missionId, options.missionId, "Runner manifest mission changed");
    assert.equal(manifest.profileHash, options.profileHash, "Runner manifest doctrine changed");
    reconciliation = await leaseManager.reconcile();
    assert.equal(
      reconciliation.readopted.length,
      manifest.workers.length,
      "Runner did not re-adopt every worker",
    );
    assert.equal(reconciliation.failed.length, 0, "Runner lost a worker during restart");
  }

  const terminalManager = new TerminalManager();
  for (const worker of manifest.workers) {
    assert(processIsAlive(worker.pid), `Worker ${worker.workerRunId} is not alive`);
    await stat(worker.logPath);
    terminalManager.spawnTerminal({
      id: worker.terminalId,
      workerRunId: worker.workerRunId,
      title: worker.taskId,
      command: process.execPath,
      transport: new DurableLogTransport(worker.logPath, worker.pid),
    });
  }
  const { replayUrl } = await startReplayServer(options.port, terminalManager);
  const terminals = await Promise.all(
    manifest.workers.map((worker) => waitForTerminalSequence(terminalManager, worker.terminalId, 3)),
  );
  const status: RunnerRecoveryStatus = {
    schemaVersion: 1,
    client: "@clankie/runner recovery probe",
    runnerPid: process.pid,
    startOrdinal: await nextStartOrdinal(options.stateRoot),
    replayUrl,
    manifest,
    leases: await leaseManager.list(),
    reconciliation,
    terminals,
  };
  await writeJsonAtomic(options.outputPath, status);
  process.stdout.write("clankie-runner: recovery checkpoint ready\n");
  return new Promise<never>(() => undefined);
}

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  assert(value, `Runner recovery probe requires ${name}`);
  return value;
}

export async function runRecoveryProbeFromCli(): Promise<never> {
  const port = Number(requiredArgument("--port"));
  assert(Number.isInteger(port) && port > 0 && port <= 65_535, "Runner recovery port is invalid");
  return runRecoveryProbe({
    stateRoot: resolve(requiredArgument("--state-root")),
    eventStorePath: resolve(requiredArgument("--event-store")),
    missionId: requiredArgument("--mission-id"),
    profileHash: requiredArgument("--profile-hash"),
    port,
    outputPath: resolve(requiredArgument("--output")),
  });
}
