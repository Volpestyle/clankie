import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectService,
  restartService,
  serviceStatePath,
  startService,
  stopService,
  type ManagedService,
  type ServiceId,
} from "../bin/service-supervisor.ts";
import {
  managedService,
  parseServiceTarget,
  resolveTargets,
  restartTarget,
  stopTarget,
} from "../bin/services.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function stateEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "clankie-services-"));
  tempDirs.push(root);
  await mkdir(join(root, "clankie"), { recursive: true });
  return { XDG_STATE_HOME: root };
}

/** A detached child that stays alive, like a real service. */
function runningChild(pid: number): ChildProcess {
  return Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    pid,
    kill: () => true,
    unref: () => {},
  }) as unknown as ChildProcess;
}

function exitingChild(exitCode: number): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    pid: 4_242,
    kill: () => true,
    unref: () => {},
  });
  queueMicrotask(() => {
    child.exitCode = exitCode;
    child.emit("exit", exitCode, null);
  });
  return child as unknown as ChildProcess;
}

interface StubOptions {
  readonly id?: ServiceId;
  readonly states?: readonly ("healthy" | "unhealthy" | "unreachable")[];
  readonly commandMatches?: (command: string) => boolean;
}

/** A service whose probe walks a scripted sequence of states. */
function stubService(options: StubOptions = {}): ManagedService {
  const states = [...(options.states ?? ["healthy"])];
  return {
    id: options.id ?? "control-plane",
    label: "Stub service",
    dependsOn: [],
    spawnArgs: ["--filter", "@clankie/stub", "start"],
    commandMatches: options.commandMatches ?? ((command) => command.includes("@clankie/stub")),
    probe: async () => ({
      state: states.length > 1 ? (states.shift() ?? "healthy") : (states[0] ?? "healthy"),
    }),
  };
}

/**
 * A fake process table. Supplied explicitly everywhere so a test never depends
 * on what happens to be running on the machine.
 */
function processList(...commands: readonly string[]): () => readonly (readonly [number, string])[] {
  return () => commands.map((command, index) => [9_900 + index, command] as const);
}

const noProcesses = processList();

async function writeRecord(env: NodeJS.ProcessEnv, id: ServiceId, pid: number): Promise<void> {
  await writeFile(
    serviceStatePath(id, env),
    `${JSON.stringify({ version: 1, id, pid, startedAt: new Date().toISOString() })}\n`,
  );
}

describe("service supervisor", () => {
  it("refuses to signal a recorded pid whose live command is a different process", async () => {
    const env = await stateEnv();
    await writeRecord(env, "control-plane", 9_001);
    let signalled = false;

    await expect(
      stopService(stubService(), {
        repoRoot: "/repo",
        env,
        processIsAliveImpl: () => true,
        // A recycled pid now belongs to something unrelated.
        readProcessCommandImpl: () => "/usr/bin/postgres -D /var/lib/postgres",
        killImpl: () => {
          signalled = true;
        },
      }),
    ).rejects.toThrow(/refusing to signal it/u);
    expect(signalled).toBe(false);
  });

  it("escalates to SIGKILL when a service ignores SIGTERM", async () => {
    const env = await stateEnv();
    await writeRecord(env, "control-plane", 9_002);
    const signals: NodeJS.Signals[] = [];
    let alive = true;

    const result = await stopService(stubService(), {
      repoRoot: "/repo",
      env,
      processIsAliveImpl: () => alive,
      readProcessCommandImpl: () => "pnpm --filter @clankie/stub start",
      killImpl: (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") alive = false;
      },
    });

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result).toMatchObject({ stopped: true, signal: "SIGKILL" });
  });

  it("clears the record after a successful stop so a restart does not reuse it", async () => {
    const env = await stateEnv();
    await writeRecord(env, "control-plane", 9_003);
    let alive = true;

    await stopService(stubService(), {
      repoRoot: "/repo",
      env,
      processIsAliveImpl: () => alive,
      readProcessCommandImpl: () => "pnpm --filter @clankie/stub start",
      killImpl: () => {
        alive = false;
      },
    });

    await expect(readFile(serviceStatePath("control-plane", env), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to stop a healthy service the launcher does not own", async () => {
    const env = await stateEnv();
    await expect(
      stopService(stubService({ states: ["healthy"] }), {
        repoRoot: "/repo",
        env,
        listProcessCommandsImpl: processList("node @clankie/stub start"),
      }),
    ).rejects.toThrow(/not started by the clankie launcher/u);
  });

  it("has nothing to stop when a service only left published state behind", async () => {
    // The Discord bridge publishes `present` on transition and never retracts
    // it on a hard exit, so a probe kept reporting a bridge that had been gone
    // for half an hour and every restart refused against a phantom. Ownership
    // is a question about processes, so an empty process table means stopped.
    const env = await stateEnv();

    await expect(
      stopService(stubService({ states: ["healthy"] }), {
        repoRoot: "/repo",
        env,
        listProcessCommandsImpl: noProcesses,
      }),
    ).resolves.toEqual({ stopped: true });
  });

  it("ignores an unrelated process that is not this service", async () => {
    const env = await stateEnv();

    await expect(
      stopService(stubService({ states: ["healthy"] }), {
        repoRoot: "/repo",
        env,
        listProcessCommandsImpl: processList("node @clankie/something-else start"),
      }),
    ).resolves.toEqual({ stopped: true });
  });

  it("reports healthy only once the probe agrees, not when the process spawns", async () => {
    const env = await stateEnv();
    const service = stubService({ states: ["unreachable", "unreachable", "healthy"] });
    const spawnImpl = (() => runningChild(9_100)) as unknown as typeof spawn;

    const status = await startService(service, {
      repoRoot: "/repo",
      env,
      spawnImpl,
      processIsAliveImpl: () => true,
    });

    expect(status).toMatchObject({ id: "control-plane", state: "healthy", owned: true, pid: 9_100 });
    const record = JSON.parse(await readFile(serviceStatePath("control-plane", env), "utf8")) as {
      pid: number;
    };
    expect(record.pid).toBe(9_100);
  });

  it("surfaces the log path when the service exits during startup", async () => {
    const env = await stateEnv();
    const service = stubService({ states: ["unreachable"] });
    const spawnImpl = (() => exitingChild(1)) as unknown as typeof spawn;

    await expect(
      startService(service, { repoRoot: "/repo", env, spawnImpl, processIsAliveImpl: () => true }),
    ).rejects.toThrow(/exited with code 1.*control-plane\.log/su);
  });

  it("does not start a second copy when the service is already healthy", async () => {
    const env = await stateEnv();
    let spawned = 0;
    const spawnImpl = (() => {
      spawned += 1;
      return runningChild(9_200);
    }) as unknown as typeof spawn;

    const status = await startService(stubService({ states: ["healthy"] }), {
      repoRoot: "/repo",
      env,
      spawnImpl,
      processIsAliveImpl: () => true,
    });

    expect(spawned).toBe(0);
    expect(status.state).toBe("healthy");
  });

  it("restarts by stopping the owned process before starting a replacement", async () => {
    const env = await stateEnv();
    await writeRecord(env, "control-plane", 9_300);
    const order: string[] = [];
    let alive = true;
    // stopService takes the owned-record path and never probes, so the first
    // probe here belongs to startService's "is it already up?" check.
    const service = stubService({ states: ["unreachable", "healthy"] });

    const status = await restartService(service, {
      repoRoot: "/repo",
      env,
      processIsAliveImpl: () => alive,
      readProcessCommandImpl: () => "pnpm --filter @clankie/stub start",
      killImpl: () => {
        order.push("stop");
        alive = false;
      },
      spawnImpl: (() => {
        order.push("start");
        alive = true;
        return runningChild(9_301);
      }) as unknown as typeof spawn,
    });

    expect(order).toEqual(["stop", "start"]);
    expect(status).toMatchObject({ state: "healthy", pid: 9_301 });
  });

  it("keeps inspection read-only when nothing is running", async () => {
    const env = await stateEnv();
    const status = await inspectService(stubService({ states: ["unreachable"] }), {
      repoRoot: "/repo",
      env,
    });
    expect(status).toMatchObject({ id: "control-plane", state: "unreachable", owned: false });
  });
});

describe("discord bridge health", () => {
  function presenceFetch(phase: string | undefined): typeof fetch {
    return (async (input: string | URL) => {
      if (!String(input).includes("/v1/discord/presence-status")) throw new Error("connection refused");
      return Response.json({
        schemaVersion: 1,
        sessions:
          phase === undefined
            ? []
            : [{ phase, gatewayConnected: true, voiceGuildCount: 0, activityCount: 0 }],
      });
    }) as unknown as typeof fetch;
  }

  it("reports a hand-started bridge as running rather than unreachable", async () => {
    const env = await stateEnv();
    const status = await inspectService(managedService("discord-bridge"), {
      repoRoot: "/repo",
      env,
      fetchImpl: presenceFetch("present"),
      operatorToken: "operator-secret",
      listProcessCommandsImpl: processList("node @clankie/discord-bridge start"),
    });

    expect(status).toMatchObject({ id: "discord-bridge", state: "healthy", owned: false });
    expect(status.detail).toContain("started outside the launcher");
  });

  it("does not invent a bridge from a presence phase no live process is backing", async () => {
    // The exact phantom: a fresh control plane replays `present` out of the
    // event store, but the bridge that published it is gone.
    const env = await stateEnv();
    const status = await inspectService(managedService("discord-bridge"), {
      repoRoot: "/repo",
      env,
      fetchImpl: presenceFetch("present"),
      operatorToken: "operator-secret",
      listProcessCommandsImpl: noProcesses,
    });

    expect(status).toMatchObject({ state: "unreachable", owned: false });
  });

  it("still reports a live bridge whose presence projection cannot be read", async () => {
    const env = await stateEnv();
    const status = await inspectService(managedService("discord-bridge"), {
      repoRoot: "/repo",
      env,
      fetchImpl: presenceFetch(undefined),
      operatorToken: "operator-secret",
      listProcessCommandsImpl: processList("node @clankie/discord-bridge start"),
    });

    expect(status).toMatchObject({ state: "healthy", owned: false });
    expect(status.detail).toContain("started outside the launcher");
  });

  it("reports unreachable when no session is present and nothing is owned", async () => {
    const env = await stateEnv();
    const status = await inspectService(managedService("discord-bridge"), {
      repoRoot: "/repo",
      env,
      fetchImpl: presenceFetch(undefined),
      operatorToken: "operator-secret",
      listProcessCommandsImpl: noProcesses,
    });

    expect(status).toMatchObject({ state: "unreachable", owned: false });
  });

  it("keeps an owned bridge healthy when the presence projection cannot be read", async () => {
    const env = await stateEnv();
    await writeRecord(env, "discord-bridge", 9_400);
    const status = await inspectService(managedService("discord-bridge"), {
      repoRoot: "/repo",
      env,
      processIsAliveImpl: () => true,
      // No operator credential: detail is unavailable, health must not degrade.
      fetchImpl: presenceFetch("present"),
    });

    expect(status).toMatchObject({ id: "discord-bridge", state: "healthy", owned: true });
    expect(status.detail).toBeUndefined();
  });
});

describe("service targets", () => {
  it("maps aliases onto canonical service ids", () => {
    expect(parseServiceTarget(undefined)).toBe("all");
    expect(parseServiceTarget("discord")).toBe("discord-bridge");
    expect(parseServiceTarget("bridge")).toBe("discord-bridge");
    expect(parseServiceTarget("cp")).toBe("control-plane");
    expect(parseServiceTarget("eve")).toBe("captain-eve");
    expect(parseServiceTarget("CAPTAIN")).toBe("captain-eve");
  });

  it("rejects an unknown target instead of guessing", () => {
    expect(() => parseServiceTarget("contorl-plane")).toThrow(/Unknown service/u);
  });

  it("restarts forwards and stops backwards along the dependency chain", () => {
    expect(resolveTargets("all")).toEqual(["captain-eve", "control-plane", "discord-bridge"]);
    expect([...resolveTargets("all")].reverse()).toEqual(["discord-bridge", "control-plane", "captain-eve"]);
  });

  it("stops the fan-out at the first failure so downstream errors cannot mask it", async () => {
    const env = await stateEnv();
    const attempted: string[] = [];

    const outcomes = await restartTarget("all", {
      repoRoot: "/repo",
      env,
      restartCaptainImpl: async () => {
        attempted.push("captain-eve");
        throw new Error("captain build failed");
      },
    });

    expect(attempted).toEqual(["captain-eve"]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ id: "captain-eve", ok: false, error: "captain build failed" });
  });

  it("stops in reverse dependency order when nothing is running", async () => {
    const env = await stateEnv();
    const outcomes = await stopTarget("all", {
      repoRoot: "/repo",
      env,
      fetchImpl: (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch,
      // Explicit, so the result does not depend on what the developer running
      // the suite happens to have up on their own machine.
      listProcessCommandsImpl: noProcesses,
    });

    expect(outcomes.map((outcome) => outcome.id)).toEqual(["discord-bridge", "control-plane", "captain-eve"]);
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
  });

  it("keeps stopping the rest after one service refuses, and says which failed", async () => {
    const env = await stateEnv();
    // A control plane that is up but was started outside the launcher: it must
    // be reported, not killed, and it must not abort the other stops. The live
    // process is what makes it unownedly-running, not the health response.
    const fetchImpl = (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.port === "4310") {
        return Response.json({ ok: true, service: "clankie-control-plane" });
      }
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const outcomes = await stopTarget("all", {
      repoRoot: "/repo",
      env,
      fetchImpl,
      listProcessCommandsImpl: processList("node @clankie/control-plane start"),
    });

    expect(outcomes.map((outcome) => [outcome.id, outcome.ok])).toEqual([
      ["discord-bridge", true],
      ["control-plane", false],
      ["captain-eve", true],
    ]);
    expect(outcomes[1]?.error).toMatch(/not started by the clankie launcher/u);
  });
});
