import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  captainStartupTimeoutMs,
  DEFAULT_CAPTAIN_STARTUP_TIMEOUT_MS,
  ensureCaptainService,
  restartCaptainService,
  type CaptainServiceHandle,
} from "../bin/captain-service.ts";
import {
  CAPTAIN_AGENT_NAME,
  CAPTAIN_AUTHORED_TOOL_NAMES,
  CAPTAIN_DISABLED_FRAMEWORK_TOOL_NAMES,
  EVE_WORKFLOW_ID,
  isCaptainInfo,
} from "../src/session/captain-identity.ts";

const TEST_GENERATION = "a".repeat(64);

function completedChild(exitCode: number): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    pid: undefined,
    kill: () => true,
  });
  queueMicrotask(() => {
    child.exitCode = exitCode;
    child.emit("exit", exitCode, null);
  });
  return child as unknown as ChildProcess;
}

function captainInfo(name = CAPTAIN_AGENT_NAME): unknown {
  return {
    kind: "eve-agent-info",
    agent: { name },
    tools: {
      authored: CAPTAIN_AUTHORED_TOOL_NAMES.map((toolName) => ({ name: toolName })),
      available: CAPTAIN_AUTHORED_TOOL_NAMES.map((toolName) => ({ name: toolName })),
      disabledFramework: [...CAPTAIN_DISABLED_FRAMEWORK_TOOL_NAMES],
    },
  };
}

describe("ensureCaptainService", () => {
  it("attaches only when the loopback endpoint identifies a ready Eve service", async () => {
    const handle = await ensureCaptainService({
      repoRoot: "/unused",
      host: "http://127.0.0.1:4321",
      fetchImpl: async (input) =>
        String(input).endsWith("/eve/v1/info")
          ? Response.json(captainInfo())
          : Response.json({ ok: true, status: "ready", workflowId: EVE_WORKFLOW_ID }),
    });

    expect(handle).toMatchObject({ host: "http://127.0.0.1:4321", owned: false });
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it("rejects an unrelated Eve agent even though its generic workflow health matches", () => {
    expect(isCaptainInfo(captainInfo("some-other-eve-agent"))).toBe(false);
  });

  it("rejects a stale captain that still exposes a broad framework tool", () => {
    const stale = captainInfo() as {
      tools: { available: Array<{ name: string }>; disabledFramework: string[] };
    };
    stale.tools.available.push({ name: "bash" });
    stale.tools.disabledFramework = stale.tools.disabledFramework.filter((name) => name !== "bash");
    expect(isCaptainInfo(stale)).toBe(false);
  });

  it("does not mistake an unrelated HTTP 200 response for the captain", async () => {
    await expect(
      ensureCaptainService({
        repoRoot: "/unused",
        host: "https://example.test:4321",
        fetchImpl: async () => Response.json({ ok: true, status: "ready", workflowId: EVE_WORKFLOW_ID }),
      }),
    ).rejects.toThrow("must use a loopback http URL");
  });

  it("builds the captain before starting the durable production runtime", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "captain-service-test-"));
    const calls: Array<{ args: readonly string[]; command: string }> = [];
    const statuses: string[] = [];
    let ready = false;
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      pid: undefined,
      kill: () => true,
    }) as unknown as ChildProcess;
    const spawnBuildImpl = ((command: string, args: readonly string[]) => {
      calls.push({ command, args });
      return completedChild(0);
    }) as unknown as typeof spawn;
    const spawnImpl = ((command: string, args: readonly string[]) => {
      calls.push({ command, args });
      ready = true;
      return child;
    }) as unknown as typeof spawn;

    try {
      const handle = await ensureCaptainService({
        repoRoot: "/repo",
        host: "http://127.0.0.1:4321",
        env: { XDG_STATE_HOME: stateRoot },
        fetchImpl: async (input) => {
          if (!ready) throw new TypeError("fetch failed");
          return String(input).endsWith("/eve/v1/info")
            ? Response.json(captainInfo())
            : Response.json({ ok: true, status: "ready", workflowId: EVE_WORKFLOW_ID });
        },
        onStatus: (status) => statuses.push(status),
        readBuildGenerationImpl: () => TEST_GENERATION,
        spawnBuildImpl,
        spawnImpl,
      });

      expect(handle.owned).toBe(true);
      expect(handle.generation).toBe(TEST_GENERATION);
      expect(statuses).toEqual([
        "Checking for a running captain…",
        "Building the durable captain…",
        "Starting the durable captain…",
      ]);
      expect(calls).toEqual([
        {
          command: "pnpm",
          args: ["--filter", "@clankie/captain-eve", "exec", "eve", "build"],
        },
        {
          command: "pnpm",
          args: [
            "--filter",
            "@clankie/captain-eve",
            "exec",
            "eve",
            "start",
            "--host",
            "127.0.0.1",
            "--port",
            "4321",
          ],
        },
      ]);
      const serviceStatePath = join(stateRoot, "clankie", "captain-eve-service.json");
      expect(JSON.parse(await readFile(serviceStatePath, "utf8"))).toMatchObject({
        generation: TEST_GENERATION,
        host: "http://127.0.0.1:4321",
        version: 1,
      });
      expect((await stat(serviceStatePath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("does not start a service when the captain build fails", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "captain-service-test-"));
    try {
      await expect(
        ensureCaptainService({
          repoRoot: "/repo",
          host: "http://127.0.0.1:4321",
          env: { XDG_STATE_HOME: stateRoot },
          fetchImpl: async () => {
            throw new TypeError("fetch failed");
          },
          readBuildGenerationImpl: () => TEST_GENERATION,
          spawnBuildImpl: (() => completedChild(1)) as unknown as typeof spawn,
          spawnImpl: (() => {
            throw new Error("start must not run");
          }) as unknown as typeof spawn,
        }),
      ).rejects.toThrow("build exited with code 1");
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("fails immediately when an unhealthy process already occupies the endpoint", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "captain-service-test-"));
    try {
      await expect(
        ensureCaptainService({
          repoRoot: "/repo",
          host: "http://127.0.0.1:4321",
          env: { XDG_STATE_HOME: stateRoot },
          fetchImpl: async () => new Response(null, { status: 503 }),
          spawnBuildImpl: (() => {
            throw new Error("build must not run");
          }) as unknown as typeof spawn,
          spawnImpl: (() => {
            throw new Error("start must not run");
          }) as unknown as typeof spawn,
        }),
      ).rejects.toThrow("occupied but unhealthy");
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("turns an asynchronous spawn failure into an actionable startup error", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "captain-service-test-"));
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      pid: undefined,
      kill: () => true,
    }) as unknown as ChildProcess;
    const spawnImpl = (() => {
      queueMicrotask(() => child.emit("error", new Error("spawn pnpm ENOENT")));
      return child;
    }) as unknown as typeof spawn;

    try {
      await expect(
        ensureCaptainService({
          repoRoot: "/unused",
          host: "http://127.0.0.1:4321",
          env: { XDG_STATE_HOME: stateRoot },
          fetchImpl: async () => {
            throw new TypeError("fetch failed");
          },
          readBuildGenerationImpl: () => TEST_GENERATION,
          spawnBuildImpl: (() => completedChild(0)) as unknown as typeof spawn,
          spawnImpl,
          timeoutMs: 500,
        }),
      ).rejects.toThrow("could not start: spawn pnpm ENOENT");
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("reads the startup timeout from the environment with a generous default", () => {
    expect(captainStartupTimeoutMs({})).toBe(DEFAULT_CAPTAIN_STARTUP_TIMEOUT_MS);
    expect(captainStartupTimeoutMs({ CLANKIE_CAPTAIN_STARTUP_TIMEOUT_MS: "5000" })).toBe(5000);
    expect(captainStartupTimeoutMs({ CLANKIE_CAPTAIN_STARTUP_TIMEOUT_MS: "nope" })).toBe(
      DEFAULT_CAPTAIN_STARTUP_TIMEOUT_MS,
    );
    expect(captainStartupTimeoutMs({ CLANKIE_CAPTAIN_STARTUP_TIMEOUT_MS: "-5" })).toBe(
      DEFAULT_CAPTAIN_STARTUP_TIMEOUT_MS,
    );
  });

  it("leaves a still-booting captain running instead of killing it when the deadline passes", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "captain-service-test-"));
    const kills: NodeJS.Signals[] = [];
    let unreffed = 0;
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      pid: 5150,
      kill: (signal: NodeJS.Signals = "SIGTERM") => {
        kills.push(signal);
        return true;
      },
      unref: () => {
        unreffed += 1;
      },
    }) as unknown as ChildProcess;
    try {
      await expect(
        ensureCaptainService({
          repoRoot: "/unused",
          host: "http://127.0.0.1:4321",
          env: { XDG_STATE_HOME: stateRoot },
          fetchImpl: async () => {
            throw new TypeError("fetch failed");
          },
          readBuildGenerationImpl: () => TEST_GENERATION,
          spawnBuildImpl: (() => completedChild(0)) as unknown as typeof spawn,
          spawnImpl: (() => child) as unknown as typeof spawn,
          timeoutMs: 300,
        }),
      ).rejects.toThrow("still starting");
      expect(kills).toEqual([]);
      expect(unreffed).toBe(1);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("restartCaptainService", () => {
  it("signals only a process that matches the launcher state and captain command", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "captain-restart-test-"));
    const stateDir = join(stateRoot, "clankie");
    const host = "http://127.0.0.1:4321";
    let reachable = true;
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const restarted: CaptainServiceHandle = {
      generation: "b".repeat(64),
      host,
      owned: true,
      stop: () => Promise.resolve(),
      stopSync: () => undefined,
    };
    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, "captain-eve-service.json"),
        `${JSON.stringify({
          version: 1,
          host,
          generation: TEST_GENERATION,
          pid: 4242,
        })}\n`,
      );

      const handle = await restartCaptainService({
        repoRoot: "/repo",
        host,
        env: { XDG_STATE_HOME: stateRoot },
        fetchImpl: async (input) => {
          if (!reachable) throw new TypeError("fetch failed");
          return String(input).endsWith("/eve/v1/info")
            ? Response.json(captainInfo())
            : Response.json({ ok: true, status: "ready", workflowId: EVE_WORKFLOW_ID });
        },
        processIsAliveImpl: () => true,
        readProcessCommandImpl: () =>
          "pnpm --filter @clankie/captain-eve exec eve start --host 127.0.0.1 --port 4321",
        killImpl: (pid, signal) => {
          signals.push({ pid, signal });
          reachable = false;
        },
        ensureImpl: async () => restarted,
      });

      expect(signals).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
      expect(handle).toBe(restarted);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("refuses to signal a healthy captain without launcher ownership", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "captain-restart-unowned-test-"));
    try {
      await expect(
        restartCaptainService({
          repoRoot: "/repo",
          host: "http://127.0.0.1:4321",
          env: { XDG_STATE_HOME: stateRoot },
          fetchImpl: async (input) =>
            String(input).endsWith("/eve/v1/info")
              ? Response.json(captainInfo())
              : Response.json({ ok: true, status: "ready", workflowId: EVE_WORKFLOW_ID }),
        }),
      ).rejects.toThrow("not owned by the clankie launcher");
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
