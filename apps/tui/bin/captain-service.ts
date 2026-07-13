import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  assertLoopbackCaptainHost,
  captainInfoGeneration,
  isCaptainInfo,
  isReadyEveHealth,
} from "../src/session/captain-identity.ts";

export const DEFAULT_CAPTAIN_URL = "http://127.0.0.1:4321";
const CONCURRENT_START_GRACE_MS = 3_000;
const BUILD_LOCK_NAME = "captain-eve-build.lock";
const SERVICE_STATE_NAME = "captain-eve-service.json";

export interface CaptainServiceRecord {
  readonly generation: string;
  readonly host: string;
  readonly pid: number;
  readonly version: 1;
}

export interface CaptainInspection {
  readonly agent?: string;
  readonly generation?: string;
  readonly healthPath: "/eve/v1/health";
  readonly host: string;
  readonly infoPath: "/eve/v1/info";
  readonly state: CaptainEndpointState;
}

export interface CaptainServiceHandle {
  readonly host: string;
  readonly owned: boolean;
  readonly generation?: string;
  stop(): Promise<void>;
  stopSync(): void;
}

export interface EnsureCaptainServiceOptions {
  readonly repoRoot: string;
  readonly host?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly onStatus?: (status: string) => void;
  readonly readBuildGenerationImpl?: (repoRoot: string) => string;
  readonly spawnBuildImpl?: typeof spawn;
  readonly spawnImpl?: typeof spawn;
  readonly timeoutMs?: number;
}

export type CaptainEndpointState = "healthy" | "unhealthy" | "unreachable";

export async function inspectCaptain(
  host: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CaptainInspection> {
  assertLoopbackCaptainHost(host);
  const base = {
    healthPath: "/eve/v1/health" as const,
    host,
    infoPath: "/eve/v1/info" as const,
  };
  let response: Response;
  try {
    response = await fetchImpl(new URL("/eve/v1/health", host), {
      redirect: "error",
      signal: AbortSignal.timeout(750),
    });
  } catch {
    return { ...base, state: "unreachable" };
  }
  if (!response.ok) return { ...base, state: "unhealthy" };
  try {
    if (!isReadyEveHealth(await response.json())) return { ...base, state: "unhealthy" };
    const info = await fetchImpl(new URL("/eve/v1/info", host), {
      redirect: "error",
      signal: AbortSignal.timeout(750),
    });
    if (!info.ok) return { ...base, state: "unhealthy" };
    const payload = await info.json();
    if (!isCaptainInfo(payload)) return { ...base, state: "unhealthy" };
    const generation = captainInfoGeneration(payload);
    return {
      ...base,
      agent: "captain-eve",
      ...(generation === undefined ? {} : { generation }),
      state: "healthy",
    };
  } catch {
    return { ...base, state: "unhealthy" };
  }
}

async function probeCaptain(host: string, fetchImpl: typeof fetch): Promise<CaptainEndpointState> {
  return (await inspectCaptain(host, fetchImpl)).state;
}

function servicePort(host: string): string {
  const url = assertLoopbackCaptainHost(host);
  return url.port || "80";
}

function stopChildSync(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // The owned process already exited.
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function captainStateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "clankie");
}

export function captainServiceStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(captainStateDirectory(env), SERVICE_STATE_NAME);
}

function clearStaleBuildLock(lockPath: string, staleAfterMs: number): void {
  try {
    const record = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
    if (typeof record.pid === "number" && Number.isSafeInteger(record.pid) && !processIsAlive(record.pid)) {
      unlinkSync(lockPath);
      return;
    }
  } catch {
    // Fall through to the age guard for malformed or concurrently removed locks.
  }
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > staleAfterMs) unlinkSync(lockPath);
  } catch {
    // Another launcher already released or replaced the lock.
  }
}

async function acquireBuildLock(input: {
  readonly deadline: number;
  readonly fetchImpl: typeof fetch;
  readonly host: string;
  readonly lockPath: string;
  readonly onWait?: () => void;
  readonly timeoutMs: number;
}): Promise<number | undefined> {
  let announcedWait = false;
  while (Date.now() < input.deadline) {
    try {
      const fd = openSync(input.lockPath, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`);
      return fd;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await probeCaptain(input.host, input.fetchImpl)) === "healthy") return undefined;
      if (!announcedWait) {
        announcedWait = true;
        input.onWait?.();
      }
      clearStaleBuildLock(input.lockPath, input.timeoutMs * 2);
      await sleep(100);
    }
  }
  throw new Error(`Timed out waiting for the shared captain build lock at ${input.lockPath}.`);
}

function readBuildGeneration(repoRoot: string): string {
  const metadataPath = join(repoRoot, "apps", "captain-eve", ".eve", "compile", "compile-metadata.json");
  let generation: unknown;
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
      discovery?: { sourceGraphHash?: unknown };
    };
    generation = metadata.discovery?.sourceGraphHash;
  } catch (error) {
    throw new Error(`Captain Eve build metadata could not be read at ${metadataPath}.`, {
      cause: error,
    });
  }
  if (typeof generation !== "string" || !/^[a-f0-9]{64}$/u.test(generation)) {
    throw new Error(`Captain Eve build metadata at ${metadataPath} has no valid source graph hash.`);
  }
  return generation;
}

async function buildCaptain(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly logFd: number;
  readonly logPath: string;
  readonly readBuildGenerationImpl: (repoRoot: string) => string;
  readonly repoRoot: string;
  readonly spawnBuildImpl: typeof spawn;
  readonly timeoutMs: number;
}): Promise<string> {
  const signal = AbortSignal.timeout(input.timeoutMs);
  const child = input.spawnBuildImpl("pnpm", ["--filter", "@clankie/captain-eve", "exec", "eve", "build"], {
    cwd: input.repoRoot,
    env: input.env,
    signal,
    stdio: ["ignore", input.logFd, input.logFd],
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", (error) => {
      reject(
        new Error(`Captain Eve build failed: ${error.message}. See ${input.logPath}.`, {
          cause: error,
        }),
      );
    });
    child.once("exit", (code, exitSignal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `Captain Eve build exited with code ${String(code)}${exitSignal === null ? "" : ` (${exitSignal})`}. See ${input.logPath}.`,
          ),
        );
      }
    });
  });
  return input.readBuildGenerationImpl(input.repoRoot);
}

export function readCaptainServiceRecord(
  path: string,
  host: string,
  processIsAliveImpl: (pid: number) => boolean = processIsAlive,
): CaptainServiceRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as {
      generation?: unknown;
      host?: unknown;
      pid?: unknown;
      version?: unknown;
    };
    return record.version === 1 &&
      record.host === host &&
      typeof record.pid === "number" &&
      Number.isSafeInteger(record.pid) &&
      record.pid > 0 &&
      processIsAliveImpl(record.pid) &&
      typeof record.generation === "string" &&
      /^[a-f0-9]{64}$/u.test(record.generation)
      ? {
          generation: record.generation,
          host: record.host,
          pid: record.pid,
          version: 1,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function readServiceGeneration(path: string, host: string): string | undefined {
  return readCaptainServiceRecord(path, host)?.generation;
}

function writeServiceGeneration(input: {
  readonly generation: string;
  readonly host: string;
  readonly path: string;
  readonly pid: number | undefined;
}): void {
  const temporary = `${input.path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify({
        version: 1,
        host: input.host,
        generation: input.generation,
        pid: input.pid,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temporary, input.path);
    chmodSync(input.path, 0o600);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // Atomic rename already consumed the temporary file.
    }
  }
}

function releaseBuildLock(fd: number, path: string): void {
  closeSync(fd);
  try {
    unlinkSync(path);
  } catch {
    // The lock is best-effort cleanup after ownership was released.
  }
}

/**
 * How long to wait for a cold captain boot before giving up. A first boot runs a
 * nitro build, loads the microsandbox template, and initializes the agent, which
 * routinely exceeds the old fixed 30s. Tunable via
 * `CLANKIE_CAPTAIN_STARTUP_TIMEOUT_MS`; the generous default keeps `clankie
 * restart` from abandoning a captain that is still coming up.
 */
export const DEFAULT_CAPTAIN_STARTUP_TIMEOUT_MS = 120_000;

export function captainStartupTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CLANKIE_CAPTAIN_STARTUP_TIMEOUT_MS?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_CAPTAIN_STARTUP_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_CAPTAIN_STARTUP_TIMEOUT_MS;
}

export async function ensureCaptainService(
  options: EnsureCaptainServiceOptions,
): Promise<CaptainServiceHandle> {
  const host = options.host ?? options.env?.CLANKIE_CAPTAIN_URL ?? DEFAULT_CAPTAIN_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const port = servicePort(host);
  const timeoutMs = options.timeoutMs ?? captainStartupTimeoutMs(options.env);
  const deadline = Date.now() + timeoutMs;
  const stateDir = captainStateDirectory(options.env);
  const serviceStatePath = join(stateDir, SERVICE_STATE_NAME);
  options.onStatus?.("Checking for a running captain…");
  if ((await probeCaptain(host, fetchImpl)) === "healthy") {
    const generation = readServiceGeneration(serviceStatePath, host);
    return {
      host,
      owned: false,
      ...(generation === undefined ? {} : { generation }),
      stop: () => Promise.resolve(),
      stopSync: () => {},
    };
  }

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const logPath = join(stateDir, "captain-eve.log");
  const lockPath = join(stateDir, BUILD_LOCK_NAME);
  const lockFd = await acquireBuildLock({
    deadline,
    fetchImpl,
    host,
    lockPath,
    onWait: () => options.onStatus?.("Waiting for another Clankie launcher…"),
    timeoutMs,
  });
  if (lockFd === undefined) {
    const generation = readServiceGeneration(serviceStatePath, host);
    return {
      host,
      owned: false,
      ...(generation === undefined ? {} : { generation }),
      stop: () => Promise.resolve(),
      stopSync: () => {},
    };
  }
  let lockHeld = true;
  const releaseLock = (): void => {
    if (!lockHeld) return;
    lockHeld = false;
    releaseBuildLock(lockFd, lockPath);
  };
  const endpointState = await probeCaptain(host, fetchImpl);
  if (endpointState === "healthy") {
    releaseLock();
    const generation = readServiceGeneration(serviceStatePath, host);
    return {
      host,
      owned: false,
      ...(generation === undefined ? {} : { generation }),
      stop: () => Promise.resolve(),
      stopSync: () => {},
    };
  }
  if (endpointState === "unhealthy") {
    releaseLock();
    throw new Error(
      `Captain endpoint ${host} is occupied but unhealthy. Stop the existing process (often a stale eve dev service), then retry.`,
    );
  }
  const logFd = openSync(logPath, "a", 0o600);
  chmodSync(logPath, 0o600);
  let child: ChildProcess | undefined;
  let generation: string;
  try {
    const env = { ...process.env, ...options.env, PORT: port };
    options.onStatus?.("Building the durable captain…");
    generation = await buildCaptain({
      env,
      logFd,
      logPath,
      readBuildGenerationImpl: options.readBuildGenerationImpl ?? readBuildGeneration,
      repoRoot: options.repoRoot,
      spawnBuildImpl: options.spawnBuildImpl ?? spawn,
      timeoutMs: Math.max(1, deadline - Date.now()),
    });
    options.onStatus?.("Starting the durable captain…");
    child = (options.spawnImpl ?? spawn)(
      "pnpm",
      ["--filter", "@clankie/captain-eve", "exec", "eve", "start", "--host", "127.0.0.1", "--port", port],
      {
        cwd: options.repoRoot,
        detached: true,
        env,
        stdio: ["ignore", logFd, logFd],
      },
    );
    writeServiceGeneration({ generation, host, path: serviceStatePath, pid: child.pid });
  } catch (error) {
    if (child !== undefined) stopChildSync(child);
    releaseLock();
    throw error;
  } finally {
    closeSync(logFd);
  }
  if (child === undefined) {
    releaseLock();
    throw new Error("Captain Eve service spawn returned no child process.");
  }
  const serviceChild = child;

  let spawnError: Error | undefined;
  let childFailureObservedAt: number | undefined;
  serviceChild.once("error", (error) => {
    spawnError = error;
  });

  while (Date.now() < deadline) {
    if ((await probeCaptain(host, fetchImpl)) === "healthy") {
      releaseLock();
      return {
        host,
        owned: true,
        generation,
        stopSync: () => stopChildSync(serviceChild),
        async stop(): Promise<void> {
          stopChildSync(serviceChild);
          await Promise.race([
            new Promise<void>((resolve) => serviceChild.once("exit", () => resolve())),
            sleep(2_000).then(() => undefined),
          ]);
        },
      };
    }
    if (spawnError !== undefined || serviceChild.exitCode !== null) {
      childFailureObservedAt ??= Date.now();
    }
    if (
      childFailureObservedAt !== undefined &&
      Date.now() - childFailureObservedAt >= CONCURRENT_START_GRACE_MS
    ) {
      if (spawnError !== undefined) {
        releaseLock();
        throw new Error(`Captain Eve service could not start: ${spawnError.message}`, {
          cause: spawnError,
        });
      }
      releaseLock();
      throw new Error(
        `Captain Eve service exited with code ${String(serviceChild.exitCode)}. See ${join(stateDir, "captain-eve.log")}.`,
      );
    }
    await sleep(100);
  }
  releaseLock();
  if (spawnError !== undefined) {
    stopChildSync(serviceChild);
    throw new Error(`Captain Eve service could not start: ${spawnError.message}`, { cause: spawnError });
  }
  if (serviceChild.exitCode !== null) {
    throw new Error(
      `Captain Eve service exited with code ${String(serviceChild.exitCode)}. See ${join(stateDir, "captain-eve.log")}.`,
    );
  }
  // Deadline reached but the process is still alive and booting (a cold nitro
  // build plus microsandbox load can exceed the window). Leave it running rather
  // than killing a captain that may be seconds from ready: its service record is
  // already written, so the next `clankie` call reuses it once health comes up.
  serviceChild.unref();
  throw new Error(
    `Captain Eve is still starting at ${host} and did not report healthy within ${Math.round(
      timeoutMs / 1_000,
    )}s. It is still coming up in the background — run \`clankie status\` shortly, or raise CLANKIE_CAPTAIN_STARTUP_TIMEOUT_MS. See ${join(stateDir, "captain-eve.log")}.`,
  );
}

export interface RestartCaptainServiceOptions extends EnsureCaptainServiceOptions {
  readonly ensureImpl?: typeof ensureCaptainService;
  readonly killImpl?: (pid: number, signal: NodeJS.Signals) => void;
  readonly processIsAliveImpl?: (pid: number) => boolean;
  readonly readProcessCommandImpl?: (pid: number) => string;
}

function readProcessCommand(pid: number): string {
  return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
}

function isLauncherCaptainCommand(command: string): boolean {
  return command.includes("@clankie/captain-eve") && /\beve\b.*\bstart\b/u.test(command);
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    process.kill(pid, signal);
  }
}

export async function restartCaptainService(
  options: RestartCaptainServiceOptions,
): Promise<CaptainServiceHandle> {
  const host = options.host ?? options.env?.CLANKIE_CAPTAIN_URL ?? DEFAULT_CAPTAIN_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  // Same generous, env-tunable startup budget as the direct ensure path; the
  // SIGTERM stop wait below stays capped at 10s via Math.min, so only the
  // build/boot wait grows. Passed through explicitly to ensureCaptainService.
  const timeoutMs = options.timeoutMs ?? captainStartupTimeoutMs(options.env);
  const statePath = captainServiceStatePath(options.env);
  const inspection = await inspectCaptain(host, fetchImpl);
  if (inspection.state === "unhealthy") {
    throw new Error(
      `Captain endpoint ${host} is occupied but does not identify as the authored captain; refusing to signal it. Inspect the listener with \`lsof -nP -iTCP:${servicePort(host)} -sTCP:LISTEN\`.`,
    );
  }

  const record = readCaptainServiceRecord(statePath, host, options.processIsAliveImpl ?? processIsAlive);
  if (inspection.state === "healthy" && record === undefined) {
    throw new Error(
      `Captain at ${host} is healthy but is not owned by the clankie launcher. Stop its owning process, then run \`clankie restart\`.`,
    );
  }
  if (record !== undefined) {
    const command = (options.readProcessCommandImpl ?? readProcessCommand)(record.pid);
    if (!isLauncherCaptainCommand(command)) {
      throw new Error(
        `Recorded captain pid ${record.pid} no longer identifies a launcher-owned Eve service; refusing to signal it.`,
      );
    }
    (options.killImpl ?? signalProcessGroup)(record.pid, "SIGTERM");
    const deadline = Date.now() + Math.min(timeoutMs, 10_000);
    while (Date.now() < deadline) {
      if ((await inspectCaptain(host, fetchImpl)).state === "unreachable") break;
      await sleep(100);
    }
    if ((await inspectCaptain(host, fetchImpl)).state !== "unreachable") {
      throw new Error(`Captain at ${host} did not stop after SIGTERM; refusing to start a replacement.`);
    }
    try {
      unlinkSync(statePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  return await (options.ensureImpl ?? ensureCaptainService)({
    repoRoot: options.repoRoot,
    host,
    fetchImpl,
    timeoutMs,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }),
    ...(options.readBuildGenerationImpl === undefined
      ? {}
      : { readBuildGenerationImpl: options.readBuildGenerationImpl }),
    ...(options.spawnBuildImpl === undefined ? {} : { spawnBuildImpl: options.spawnBuildImpl }),
    ...(options.spawnImpl === undefined ? {} : { spawnImpl: options.spawnImpl }),
  });
}
