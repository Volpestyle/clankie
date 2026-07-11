import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
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

export interface CaptainServiceHandle {
  readonly host: string;
  readonly owned: boolean;
  stop(): Promise<void>;
  stopSync(): void;
}

export interface EnsureCaptainServiceOptions {
  readonly repoRoot: string;
  readonly host?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly spawnImpl?: typeof spawn;
  readonly timeoutMs?: number;
}

async function healthy(host: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(new URL("/eve/v1/health", host), {
      redirect: "error",
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return false;
    if (!isReadyEveHealth(await response.json())) return false;
    const info = await fetchImpl(new URL("/eve/v1/info", host), {
      redirect: "error",
      signal: AbortSignal.timeout(750),
    });
    return info.ok && isCaptainInfo(await info.json());
  } catch {
    return false;
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

export async function ensureCaptainService(
  options: EnsureCaptainServiceOptions,
): Promise<CaptainServiceHandle> {
  const host = options.host ?? options.env?.SAPLING_CAPTAIN_URL ?? DEFAULT_CAPTAIN_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const port = servicePort(host);
  if (await healthy(host, fetchImpl)) {
    return { host, owned: false, stop: () => Promise.resolve(), stopSync: () => {} };
  }

  const stateDir = join(options.env?.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "clankie");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const logPath = join(stateDir, "captain-eve.log");
  const logFd = openSync(logPath, "a", 0o600);
  chmodSync(logPath, 0o600);
  let child: ChildProcess;
  try {
    child = (options.spawnImpl ?? spawn)(
      "pnpm",
      [
        "--filter",
        "@sapling/captain-eve",
        "exec",
        "eve",
        "dev",
        "--no-ui",
        "--host",
        "127.0.0.1",
        "--port",
        port,
      ],
      {
        cwd: options.repoRoot,
        detached: true,
        env: { ...process.env, ...options.env, PORT: port },
        stdio: ["ignore", logFd, logFd],
      },
    );
  } finally {
    closeSync(logFd);
  }

  let spawnError: Error | undefined;
  let childFailureObservedAt: number | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });

  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (await healthy(host, fetchImpl)) {
      return {
        host,
        owned: true,
        stopSync: () => stopChildSync(child),
        async stop(): Promise<void> {
          stopChildSync(child);
          await Promise.race([
            new Promise<void>((resolve) => child.once("exit", () => resolve())),
            sleep(2_000).then(() => undefined),
          ]);
        },
      };
    }
    if (spawnError !== undefined || child.exitCode !== null) {
      childFailureObservedAt ??= Date.now();
    }
    if (
      childFailureObservedAt !== undefined &&
      Date.now() - childFailureObservedAt >= CONCURRENT_START_GRACE_MS
    ) {
      if (spawnError !== undefined) {
        throw new Error(`Captain Eve service could not start: ${spawnError.message}`, {
          cause: spawnError,
        });
      }
      throw new Error(
        `Captain Eve service exited with code ${String(child.exitCode)}. See ${join(stateDir, "captain-eve.log")}.`,
      );
    }
    await sleep(100);
  }
  stopChildSync(child);
  if (spawnError !== undefined) {
    throw new Error(`Captain Eve service could not start: ${spawnError.message}`, { cause: spawnError });
  }
  if (child.exitCode !== null) {
    throw new Error(
      `Captain Eve service exited with code ${String(child.exitCode)}. See ${join(stateDir, "captain-eve.log")}.`,
    );
  }
  throw new Error(`Captain Eve service did not become healthy at ${host} within the startup timeout.`);
}
