import { spawn, type ChildProcess } from "node:child_process";
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
  isCaptainInfo,
  isReadyEveHealth,
} from "../src/session/captain-identity.ts";

export const DEFAULT_CAPTAIN_URL = "http://127.0.0.1:4321";
const CONCURRENT_START_GRACE_MS = 3_000;
const BUILD_LOCK_NAME = "captain-eve-build.lock";
const SERVICE_STATE_NAME = "captain-eve-service.json";

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

type CaptainEndpointState = "healthy" | "unhealthy" | "unreachable";

async function probeCaptain(host: string, fetchImpl: typeof fetch): Promise<CaptainEndpointState> {
  let response: Response;
  try {
    response = await fetchImpl(new URL("/eve/v1/health", host), {
      redirect: "error",
      signal: AbortSignal.timeout(750),
    });
  } catch {
    return "unreachable";
  }
  if (!response.ok) return "unhealthy";
  try {
    if (!isReadyEveHealth(await response.json())) return "unhealthy";
    const info = await fetchImpl(new URL("/eve/v1/info", host), {
      redirect: "error",
      signal: AbortSignal.timeout(750),
    });
    return info.ok && isCaptainInfo(await info.json()) ? "healthy" : "unhealthy";
  } catch {
    return "unhealthy";
  }
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
  const child = input.spawnBuildImpl("pnpm", ["--filter", "@sapling/captain-eve", "exec", "eve", "build"], {
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

function readServiceGeneration(path: string, host: string): string | undefined {
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
      processIsAlive(record.pid) &&
      typeof record.generation === "string" &&
      /^[a-f0-9]{64}$/u.test(record.generation)
      ? record.generation
      : undefined;
  } catch {
    return undefined;
  }
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

export async function ensureCaptainService(
  options: EnsureCaptainServiceOptions,
): Promise<CaptainServiceHandle> {
  const host = options.host ?? options.env?.SAPLING_CAPTAIN_URL ?? DEFAULT_CAPTAIN_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const port = servicePort(host);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  const stateDir = join(options.env?.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "clankie");
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
      ["--filter", "@sapling/captain-eve", "exec", "eve", "start", "--host", "127.0.0.1", "--port", port],
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
  stopChildSync(serviceChild);
  releaseLock();
  if (spawnError !== undefined) {
    throw new Error(`Captain Eve service could not start: ${spawnError.message}`, { cause: spawnError });
  }
  if (serviceChild.exitCode !== null) {
    throw new Error(
      `Captain Eve service exited with code ${String(serviceChild.exitCode)}. See ${join(stateDir, "captain-eve.log")}.`,
    );
  }
  throw new Error(`Captain Eve service did not become healthy at ${host} within the startup timeout.`);
}
