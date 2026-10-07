import { execFile, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parsePositiveInt } from "@clankie/settings";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectService,
  restartService,
  serviceStatePath,
  startService,
  stopService,
  type ManagedService,
  type ServiceCommandOptions,
  type ServiceId,
} from "../bin/service-supervisor.ts";
import {
  clankieStopGraceMs,
  inspectServices,
  managedService,
  parseServiceTarget,
  resolveTargets,
  resolveRestartTargets,
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
    id: options.id ?? "clankie",
    label: "Stub service",
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
  await writeFile(serviceStatePath(id, env), `${JSON.stringify({ version: 1, id, pid })}\n`);
}

describe("service supervisor", () => {
  it("starts a real pnpm service from its own inherited lifecycle environment", async () => {
    const state = await stateEnv();
    const root = state.XDG_STATE_HOME!;
    const ready = join(root, "ready.json");
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@clankie/restart-fixture",
        private: true,
        scripts: { start: "node ready.cjs" },
      }),
    );
    await writeFile(
      join(root, "ready.cjs"),
      `require('node:fs').writeFileSync(${JSON.stringify(ready)}, JSON.stringify({session: process.env.PI_SESSION_FILE ?? null}));`,
    );
    const env = {
      ...process.env,
      ...state,
      npm_lifecycle_event: "start",
      npm_lifecycle_script: "node ready.cjs",
      PNPM_SCRIPT_SRC_DIR: root,
      PI_SESSION_FILE: "/old/discord/session.jsonl",
    };
    const result = await startService(
      {
        ...stubService(),
        spawnArgs: ["--filter", "@clankie/restart-fixture", "start"],
        probe: async () => ({ state: existsSync(ready) ? "healthy" : "unreachable" }),
      },
      {
        repoRoot: root,
        env,
        listProcessCommandsImpl: noProcesses,
      },
    );
    expect(result.state).toBe("healthy");
    expect(JSON.parse(await readFile(ready, "utf8"))).toEqual({ session: null });
    expect(env.npm_lifecycle_event).toBe("start");
  });

  // 2026-10-07: pnpm (the recorded pid) exited on SIGTERM while the service
  // beneath it lingered, so the stop never escalated and the old service kept
  // answering the operator seat's bridge after the update.
  it("kills a real pnpm service's lingering descendants when pnpm itself exits on SIGTERM", async () => {
    const state = await stateEnv();
    const root = state.XDG_STATE_HOME!;
    const pidFile = join(root, "service.pid");
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@clankie/linger-fixture",
        private: true,
        // `&&` keeps the shell between pnpm and node, as the real start script does.
        scripts: { start: "node linger.cjs && true" },
      }),
    );
    await writeFile(
      join(root, "linger.cjs"),
      `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1e6);`,
    );
    const service: ManagedService = {
      ...stubService(),
      spawnArgs: ["--filter", "@clankie/linger-fixture", "start"],
      commandMatches: (command) => command.includes("@clankie/linger-fixture"),
      stopGraceMs: () => 1_500,
      probe: async () => ({ state: existsSync(pidFile) ? "healthy" : "unreachable" }),
    };
    const options = {
      repoRoot: root,
      env: { ...process.env, ...state },
      listProcessCommandsImpl: noProcesses,
    };
    await startService(service, options);
    const servicePid = Number(await readFile(pidFile, "utf8"));
    try {
      const result = await stopService(service, options);
      expect(result).toMatchObject({ stopped: true, signal: "SIGKILL" });
      expect(() => process.kill(servicePid, 0)).toThrow();
    } finally {
      try {
        process.kill(servicePid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }, 20_000);

  it("gives Clankie longer than its configured play shutdown deadline", () => {
    expect(clankieStopGraceMs({})).toBe(17_000);
    expect(clankieStopGraceMs({ CLANKIE_PLAY_SHUTDOWN_DEADLINE_MS: "25000" })).toBe(27_000);
    expect(clankieStopGraceMs({ CLANKIE_PLAY_SHUTDOWN_DEADLINE_MS: "nope" })).toBe(17_000);
    expect(managedService("clankie").stopGraceMs?.({})).toBeGreaterThan(15_000);
  });

  it.each([undefined, "", "  ", "25000", "25000ms", "1.5", "0", "-1", "nope"])(
    "parses play shutdown deadline %j exactly like Clankie",
    (raw) => {
      expect(clankieStopGraceMs({ CLANKIE_PLAY_SHUTDOWN_DEADLINE_MS: raw }) - 2_000).toBe(
        parsePositiveInt(raw, 15_000),
      );
    },
  );

  it("refuses to signal a recorded pid whose live command is a different process", async () => {
    const env = await stateEnv();
    await writeRecord(env, "clankie", 9_001);
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
    await writeRecord(env, "clankie", 9_002);
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
    await writeRecord(env, "clankie", 9_003);
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

    await expect(readFile(serviceStatePath("clankie", env), "utf8")).rejects.toMatchObject({
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

    expect(status).toMatchObject({ id: "clankie", state: "healthy", owned: true, pid: 9_100 });
    const record = JSON.parse(await readFile(serviceStatePath("clankie", env), "utf8")) as {
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
    ).rejects.toThrow(/exited with code 1.*clankie\.log/su);
  });

  it("starts an unowned service whose probe is unhealthy but has no process behind it", async () => {
    // The activity tunnel's probe asks a public hostname, and Cloudflare answers
    // 530 when a tunnel's origin is down — which the probe reports as unhealthy.
    // Refusing to start on that reading is backwards: an edge serving 5xx
    // because cloudflared is not running is exactly when it must be started.
    // "Occupied" has to mean a process exists, not that a probe was unhappy.
    const env = await stateEnv();
    let spawned = 0;
    const spawnImpl = (() => {
      spawned += 1;
      return runningChild(9_300);
    }) as unknown as typeof spawn;

    const status = await startService(stubService({ states: ["unhealthy", "healthy"] }), {
      repoRoot: "/repo",
      env,
      spawnImpl,
      processIsAliveImpl: () => true,
      listProcessCommandsImpl: noProcesses,
    });

    expect(spawned).toBe(1);
    expect(status.state).toBe("healthy");
  });

  it("still refuses to start when a foreign process really is holding the service", async () => {
    const env = await stateEnv();
    let spawned = 0;
    const spawnImpl = (() => {
      spawned += 1;
      return runningChild(9_400);
    }) as unknown as typeof spawn;

    await expect(
      startService(stubService({ states: ["unhealthy"] }), {
        repoRoot: "/repo",
        env,
        spawnImpl,
        processIsAliveImpl: () => true,
        listProcessCommandsImpl: processList("node @clankie/stub start"),
      }),
    ).rejects.toThrow(/occupied by a process the clankie launcher does not own/u);
    expect(spawned).toBe(0);
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
    await writeRecord(env, "clankie", 9_300);
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
    expect(status).toMatchObject({ id: "clankie", state: "unreachable", owned: false });
  });
});

describe("instance occupancy", () => {
  it.each([
    {
      id: "clankie" as const,
      env: { PORT: "4390", CLANKIE_CONTROL_PLANE_URL: "http://127.0.0.1:4390" },
      port: 4390,
    },
    { id: "relay" as const, env: { CLANKIE_RELAY_PORT: "4391" }, port: 4391 },
    { id: "activity" as const, env: { CLANKIE_ACTIVITY_PORT: "4392" }, port: 4392 },
  ])(
    "stops and restarts $id on its free port despite a foreign matching command",
    async ({ id, env: config, port }) => {
      const env = { ...(await stateEnv()), ...config };
      const service = managedService(id);
      let spawned = false;
      const inspectedPorts: number[] = [];
      const options: ServiceCommandOptions = {
        repoRoot: "/repo",
        env,
        listProcessCommandsImpl: processList(
          `pnpm --filter @clankie/${id === "activity" ? "discord-activity" : id} start`,
        ),
        listPortOwnersImpl: (candidate) => {
          inspectedPorts.push(candidate);
          return [];
        },
        processIsAliveImpl: () => spawned,
        killImpl: () => {
          throw new Error("must not signal the foreign instance");
        },
        fetchImpl: (async () => {
          if (!spawned) throw new Error("connection refused");
          return Response.json({ ok: true });
        }) as typeof fetch,
        spawnImpl: (() => {
          spawned = true;
          return runningChild(9_800);
        }) as unknown as typeof spawn,
      };
      await expect(stopService(service, options)).resolves.toEqual({ stopped: true });
      await expect(restartService(service, options)).resolves.toMatchObject({
        state: "healthy",
        owned: true,
        pid: 9_800,
      });
      expect(inspectedPorts).toEqual(
        id === "activity" ? [port, 4322, port, 4322, port, 4322] : [port, port, port],
      );
    },
  );

  it.each([
    { label: "held by an unrelated listener", owners: [8_888] },
    { label: "inspection unavailable", owners: undefined },
  ])("refuses both start and stop when the port is $label", async ({ owners }) => {
    const service = managedService("relay");
    const options: ServiceCommandOptions = {
      repoRoot: "/repo",
      env: await stateEnv(),
      listProcessCommandsImpl: processList("pnpm --filter @clankie/relay start"),
      listPortOwnersImpl: () => owners,
      fetchImpl: (async () => {
        throw new Error("connection refused");
      }) as typeof fetch,
      spawnImpl: (() => {
        throw new Error("must not start a duplicate");
      }) as typeof spawn,
      killImpl: () => {
        throw new Error("must not signal an unowned listener");
      },
    };
    await expect(stopService(service, options)).rejects.toThrow(/not started by the clankie launcher/u);
    await expect(startService(service, options)).rejects.toThrow(/occupied by a process/u);
  });

  it.each([[8_888], undefined])(
    "checks the activity producer port even when its main port is free: %j",
    async (producerOwners) => {
      const service = managedService("activity");
      const options: ServiceCommandOptions = {
        repoRoot: "/repo",
        env: { ...(await stateEnv()), CLANKIE_ACTIVITY_PORT: "4392", CLANKIE_ACTIVITY_PRODUCER_PORT: "4393" },
        listProcessCommandsImpl: processList("pnpm --filter @clankie/discord-activity start"),
        listPortOwnersImpl: (port) => (port === 4393 ? producerOwners : []),
        fetchImpl: (async () => {
          throw new Error("connection refused");
        }) as typeof fetch,
        spawnImpl: (() => {
          throw new Error("must not collide with the producer");
        }) as typeof spawn,
        killImpl: () => {
          throw new Error("must not signal an unowned producer");
        },
      };
      await expect(stopService(service, options)).rejects.toThrow(/not started by the clankie launcher/u);
      await expect(startService(service, options)).rejects.toThrow(/occupied by a process/u);
    },
  );

  it.each([
    { command: "cloudflared tunnel run other-tunnel", conflicts: false },
    { command: "cloudflared tunnel run clankie-activity", conflicts: true },
    { command: "cloudflared tunnel run --token opaque", conflicts: true },
    { command: "", conflicts: true },
  ])("scopes a tunnel conflict using its live name: $command", async ({ command, conflicts }) => {
    const service = managedService("tunnel");
    let spawned = false;
    const options: ServiceCommandOptions = {
      repoRoot: "/repo",
      env: {
        ...(await stateEnv()),
        CLANKIE_ACTIVITY_TUNNEL_NAME: "clankie-activity",
        CLANKIE_ACTIVITY_TUNNEL_HOSTNAME: "clankie.example.com",
      },
      listProcessCommandsImpl: processList("cloudflared tunnel run other-tunnel"),
      readProcessCommandImpl: () => command,
      processIsAliveImpl: () => spawned,
      killImpl: () => {
        throw new Error("must not signal an unowned tunnel");
      },
      fetchImpl: (async () => new Response("", { status: spawned ? 200 : 503 })) as typeof fetch,
      spawnImpl: (() => {
        spawned = true;
        return runningChild(9_801);
      }) as unknown as typeof spawn,
    };
    if (conflicts) {
      await expect(stopService(service, options)).rejects.toThrow(/not started by the clankie launcher/u);
      await expect(startService(service, options)).rejects.toThrow(/occupied by a process/u);
      expect(spawned).toBe(false);
    } else {
      await expect(restartService(service, options)).resolves.toMatchObject({
        state: "healthy",
        owned: true,
      });
    }
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
      listProcessCommandsImpl: processList("node pnpm.mjs --filter @clankie/discord-bridge start"),
    });

    expect(status).toMatchObject({ id: "discord-bridge", state: "healthy", owned: false });
    expect(status.detail).toContain("started outside the launcher");
  });

  it("does not invent a bridge from a presence phase no live process is backing", async () => {
    // The exact phantom: a fresh service replays `present` out of the event
    // store, but the bridge that published it is gone.
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
      listProcessCommandsImpl: processList("node pnpm.mjs --filter @clankie/discord-bridge start"),
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
    // The old three backends are one service now; every old name lands on it.
    expect(parseServiceTarget("cp")).toBe("clankie");
    expect(parseServiceTarget("control-plane")).toBe("clankie");
    expect(parseServiceTarget("eve")).toBe("clankie");
    expect(parseServiceTarget("CAPTAIN")).toBe("clankie");
    expect(parseServiceTarget("captain-eve")).toBe("clankie");
    expect(parseServiceTarget("lab")).toBe("discord-user-session");
    expect(parseServiceTarget("user-session")).toBe("discord-user-session");
    expect(parseServiceTarget("relay")).toBe("relay");
    expect(parseServiceTarget("app-relay")).toBe("relay");
    expect(parseServiceTarget("phone")).toBe("relay");
  });

  it("starts only the active Discord body", () => {
    expect(managedService("discord-bridge").enabled?.({})).toBe(true);
    expect(managedService("discord-bridge").enabled?.({ DISCORD_ACTIVE_BODY: "user_session" })).toBe(false);
    expect(managedService("discord-user-session").enabled?.({ DISCORD_USER_SESSION_ENABLED: "true" })).toBe(
      false,
    );
    expect(
      managedService("discord-user-session").enabled?.({
        DISCORD_USER_SESSION_ENABLED: "true",
        DISCORD_ACTIVE_BODY: "user_session",
      }),
    ).toBe(true);
  });

  it.each([
    {
      label: "user-session to bot with voice enabled",
      target: "discord-user-session" as const,
      env: { DISCORD_ACTIVE_BODY: "bot", DISCORD_VOICE_ENABLED: "true" },
      started: "@clankie/discord-bridge",
      outcome: "discord-bridge",
    },
    {
      label: "user-session to bot with voice disabled",
      target: "discord-user-session" as const,
      env: { DISCORD_ACTIVE_BODY: "bot", DISCORD_VOICE_ENABLED: "false" },
      started: "@clankie/discord-bridge",
      outcome: "discord-bridge",
    },
    {
      label: "bot to user-session with voice enabled",
      target: "discord-bridge" as const,
      env: {
        DISCORD_ACTIVE_BODY: "user_session",
        DISCORD_USER_SESSION_ENABLED: "true",
        DISCORD_USER_SESSION_VOICE_ENABLED: "true",
      },
      started: "@clankie/discord-user-session",
      outcome: "discord-user-session",
    },
    {
      label: "bot to user-session with voice disabled",
      target: "discord-bridge" as const,
      env: {
        DISCORD_ACTIVE_BODY: "user_session",
        DISCORD_USER_SESSION_ENABLED: "true",
        DISCORD_USER_SESSION_VOICE_ENABLED: "false",
      },
      started: "@clankie/discord-user-session",
      outcome: "discord-user-session",
    },
  ])("stops both Discord bodies before starting only the selected body: $label", async (candidate) => {
    const env = { ...(await stateEnv()), ...candidate.env };
    await writeRecord(env, "discord-bridge", 9_501);
    await writeRecord(env, "discord-user-session", 9_502);
    const alive = new Set([9_501, 9_502]);
    const order: string[] = [];
    let nextPid = 9_503;

    const outcomes = await restartTarget(candidate.target, {
      repoRoot: "/repo",
      env,
      processIsAliveImpl: (pid) => alive.has(pid),
      readProcessCommandImpl: (pid) =>
        pid === 9_501
          ? "pnpm --filter @clankie/discord-bridge start"
          : "pnpm --filter @clankie/discord-user-session start",
      killImpl: (pid) => {
        order.push(pid === 9_501 ? "stop:bot" : "stop:user-session");
        alive.delete(pid);
      },
      listProcessCommandsImpl: noProcesses,
      fetchImpl: (async () =>
        alive.has(9_503)
          ? Response.json({ ok: true })
          : Promise.reject(new Error("connection refused"))) as typeof fetch,
      spawnImpl: ((_command: string, args: string[]) => {
        const pkg = args[1] ?? "unknown";
        order.push(`start:${pkg}`);
        const pid = nextPid++;
        alive.add(pid);
        return runningChild(pid);
      }) as unknown as typeof spawn,
    });

    expect(order).toEqual(["stop:user-session", "stop:bot", `start:${candidate.started}`]);
    expect(outcomes).toEqual([expect.objectContaining({ id: candidate.outcome, ok: true })]);
  });

  it("starts only the loadout and stops a leftover outside it", async () => {
    // A hosted body runs `clankie,relay`: the Discord bridge that `restart
    // clankie` otherwise carries has nothing to talk to and keeps the body awake.
    const env = { ...(await stateEnv()), CLANKIE_SERVICES: "clankie, relay" };
    await writeRecord(env, "discord-bridge", 9_701);
    const alive = new Set([9_701]);
    const order: string[] = [];
    const started = new Set<string>();
    let nextPid = 9_702;

    const outcomes = await restartTarget("clankie", {
      repoRoot: "/repo",
      env,
      processIsAliveImpl: (pid) => alive.has(pid),
      readProcessCommandImpl: () => "pnpm --filter @clankie/discord-bridge start",
      listPortOwnersImpl: () => [],
      killImpl: (pid) => {
        order.push(`stop:${String(pid)}`);
        alive.delete(pid);
      },
      listProcessCommandsImpl: noProcesses,
      fetchImpl: (async (input: unknown) =>
        started.has(String(input).includes(":4321/") ? "@clankie/relay" : "@clankie/clankie")
          ? Response.json({ ok: true })
          : Promise.reject(new Error("connection refused"))) as typeof fetch,
      spawnImpl: ((_command: string, args: string[]) => {
        started.add(args[1] ?? "unknown");
        order.push(`start:${args[1] ?? "unknown"}`);
        const pid = nextPid++;
        alive.add(pid);
        return runningChild(pid);
      }) as unknown as typeof spawn,
    });

    expect(order).toEqual(["stop:9701", "start:@clankie/clankie", "start:@clankie/relay"]);
    expect(outcomes.map((outcome) => outcome.id)).toEqual(["clankie", "relay"]);
    expect(managedService("activity").enabled?.(env)).toBe(false);
    expect(managedService("discord-bridge").enabled?.({})).toBe(true);
    const status = await inspectService(managedService("discord-bridge"), {
      repoRoot: "/repo",
      env,
      listProcessCommandsImpl: noProcesses,
      fetchImpl: (async () => Promise.reject(new Error("unused"))) as typeof fetch,
    });
    expect(status).toMatchObject({ state: "healthy", detail: "off in this loadout" });
  });

  it("leaves both Discord bodies stopped and reports a selected-body EADDRINUSE failure", async () => {
    const env = {
      ...(await stateEnv()),
      DISCORD_ACTIVE_BODY: "user_session",
      DISCORD_USER_SESSION_ENABLED: "true",
      DISCORD_USER_SESSION_VOICE_ENABLED: "true",
    };
    await writeRecord(env, "discord-bridge", 9_601);
    await writeRecord(env, "discord-user-session", 9_602);
    const alive = new Set([9_601, 9_602]);
    const order: string[] = [];

    const outcomes = await restartTarget("discord-bridge", {
      repoRoot: "/repo",
      env,
      processIsAliveImpl: (pid) => alive.has(pid),
      readProcessCommandImpl: (pid) =>
        pid === 9_601
          ? "pnpm --filter @clankie/discord-bridge start"
          : "pnpm --filter @clankie/discord-user-session start",
      killImpl: (pid) => {
        order.push(pid === 9_601 ? "stop:bot" : "stop:user-session");
        alive.delete(pid);
      },
      listProcessCommandsImpl: noProcesses,
      fetchImpl: (async () => {
        throw new Error("connection refused");
      }) as typeof fetch,
      spawnImpl: ((_command: string, args: string[]) => {
        order.push(`start:${args[1] ?? "unknown"}`);
        const error = new Error("listen EADDRINUSE: address already in use 127.0.0.1:4323");
        Object.assign(error, { code: "EADDRINUSE" });
        throw error;
      }) as unknown as typeof spawn,
    });

    expect(order).toEqual(["stop:user-session", "stop:bot", "start:@clankie/discord-user-session"]);
    expect(outcomes).toEqual([
      expect.objectContaining({
        id: "discord-user-session",
        ok: false,
        error: expect.stringContaining("EADDRINUSE"),
      }),
    ]);
    expect(alive.size).toBe(0);
    await expect(readFile(serviceStatePath("discord-bridge", env), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(serviceStatePath("discord-user-session", env), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("recognizes the service's own spawn, not every mention of its package", () => {
    const matches = managedService("clankie").commandMatches;
    expect(matches("node /path/pnpm.mjs --filter @clankie/clankie start")).toBe(true);
    expect(
      matches(
        "/Users/person/.local/share/clankie/current/libexec/node " +
          "/Users/person/.local/share/clankie/current/apps/clankie/src/index.js",
      ),
    ).toBe(true);
    // Agent shells that merely name the package are not a running service.
    expect(matches("pnpm --filter @clankie/clankie test")).toBe(false);
    expect(matches("rg @clankie/clankie apps/tui")).toBe(false);
    expect(matches("rg apps/clankie/src/index.js")).toBe(false);
  });

  it("rejects an unknown target instead of guessing", () => {
    expect(() => parseServiceTarget("contorl-plane")).toThrow(/Unknown service/u);
  });

  it("restarts forwards and stops backwards along the dependency chain", () => {
    expect(resolveTargets("all")).toEqual([
      "clankie",
      "relay",
      "discord-bridge",
      "discord-user-session",
      "activity",
      // The tunnel fronts the activity surface, so it starts after the thing it
      // publishes and is torn down before it.
      "tunnel",
      // The owner's keep-awake holds the Mac up for all of the above.
      "awake",
    ]);
    expect([...resolveTargets("all")].reverse()).toEqual([
      "awake",
      "tunnel",
      "activity",
      "discord-user-session",
      "discord-bridge",
      "relay",
      "clankie",
    ]);
  });

  it("calls a tunnel with a dead edge unhealthy even while cloudflared runs", async () => {
    // The 2026-08-01 failure exactly: a live `cloudflared`, a healthy local
    // activity server, and an edge that had been failing for days. Anything
    // that probed the process table called this fine and the activity rendered
    // blank in Discord with nothing anywhere saying why.
    const status = await inspectService(managedService("tunnel"), {
      repoRoot: "/repo",
      env: {
        CLANKIE_ACTIVITY_TUNNEL_NAME: "clankie-activity",
        CLANKIE_ACTIVITY_TUNNEL_HOSTNAME: "clankie.example.com",
      },
      fetchImpl: (async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      }) as unknown as typeof fetch,
      listProcessCommandsImpl: processList("cloudflared tunnel run clankie-activity"),
    });

    expect(status).toMatchObject({ id: "tunnel", state: "unhealthy" });
    expect(status.detail).toMatch(/despite a live cloudflared/u);
  });

  it("separates a dead edge from a live edge with nothing behind it", async () => {
    // A 502 is the other repair entirely — the tunnel is fine and the thing it
    // publishes is down — so it must not read as "the tunnel is broken".
    const status = await inspectService(managedService("tunnel"), {
      repoRoot: "/repo",
      env: {
        CLANKIE_ACTIVITY_TUNNEL_NAME: "clankie-activity",
        CLANKIE_ACTIVITY_TUNNEL_HOSTNAME: "clankie.example.com",
      },
      fetchImpl: (async () => new Response("", { status: 502 })) as unknown as typeof fetch,
      listProcessCommandsImpl: processList("cloudflared tunnel run clankie-activity"),
    });

    expect(status.detail).toMatch(/edge up, origin down/u);
  });

  it("stays out of the way when no tunnel is configured", async () => {
    const status = await inspectService(managedService("tunnel"), {
      repoRoot: "/repo",
      env: {},
      fetchImpl: (async () => {
        throw new Error("should never be called");
      }) as unknown as typeof fetch,
      listProcessCommandsImpl: noProcesses,
    });

    // Not an error to report and not a process to start: an operator who wants
    // the activity local should never be told something is broken.
    expect(status).toMatchObject({ state: "healthy" });
    expect(status.detail).toMatch(/not configured/u);
  });

  it("never spawns an unconfigured tunnel", async () => {
    const spawned: string[] = [];
    const status = await startService(managedService("tunnel"), {
      repoRoot: "/repo",
      env: await stateEnv(),
      fetchImpl: (async () => new Response("")) as unknown as typeof fetch,
      listProcessCommandsImpl: noProcesses,
      spawnImpl: ((command: string) => {
        spawned.push(command);
        return runningChild(1234);
      }) as unknown as typeof spawn,
    });

    // `cloudflared tunnel run ""` is not a command anyone wants run for them.
    expect(spawned).toEqual([]);
    expect(status.state).toBe("healthy");
  });

  describe("keep-awake", () => {
    const optedIn = async (): Promise<NodeJS.ProcessEnv> => ({
      ...(await stateEnv()),
      CLANKIE_KEEP_AWAKE: "1",
    });
    const unusedFetch = (async () => {
      throw new Error("keep-awake has no network surface");
    }) as unknown as typeof fetch;

    it("never spawns caffeinate unless the owner opted in, and off is not a fault", async () => {
      const spawned: string[] = [];
      const status = await startService(managedService("awake"), {
        repoRoot: "/repo",
        env: await stateEnv(),
        fetchImpl: unusedFetch,
        listProcessCommandsImpl: noProcesses,
        spawnImpl: ((command: string) => {
          spawned.push(command);
          return runningChild(1234);
        }) as unknown as typeof spawn,
      });

      expect(spawned).toEqual([]);
      expect(status).toMatchObject({ id: "awake", state: "healthy" });
      expect(status.detail).toMatch(/off/u);
    });

    it.skipIf(process.platform !== "darwin")(
      "spawns `caffeinate -s` (plugged-in only) once opted in, and reports it held",
      async () => {
        const env = await optedIn();
        const spawned: (readonly string[])[] = [];
        const status = await startService(managedService("awake"), {
          repoRoot: "/repo",
          env,
          fetchImpl: unusedFetch,
          // The process table shows the spawned pid once it exists.
          listProcessCommandsImpl: () => (spawned.length === 0 ? [] : [[5_150, "/usr/bin/caffeinate -s"]]),
          processIsAliveImpl: (pid) => pid === 5_150,
          spawnImpl: ((command: string, args: readonly string[]) => {
            spawned.push([command, ...args]);
            return runningChild(5_150);
          }) as unknown as typeof spawn,
        });

        // `-s` alone: macOS honors it on AC only, so unplugging lets the Mac
        // sleep and nothing here watches the charger. `-i` would hold on battery.
        expect(spawned).toEqual([["caffeinate", "-s"]]);
        expect(status).toMatchObject({ id: "awake", state: "healthy", owned: true });
        expect(status.detail).toMatch(/plugged in/u);
      },
    );

    it.skipIf(process.platform !== "darwin")(
      "reports a requested keep-awake with no caffeinate as unreachable, naming the repair",
      async () => {
        const status = await inspectService(managedService("awake"), {
          repoRoot: "/repo",
          env: await optedIn(),
          fetchImpl: unusedFetch,
          listProcessCommandsImpl: noProcesses,
        });

        expect(status.state).toBe("unreachable");
        expect(status.detail).toContain("clankie restart awake");
      },
    );

    it.skipIf(process.platform !== "darwin")(
      "neither conflicts with nor mistakes an owner's own `caffeinate -s` for its own",
      async () => {
        const env = await optedIn();
        const service = managedService("awake");
        const foreign = processList("/usr/bin/caffeinate -s");

        // Not launcher-owned, so it reads as not held by the launcher...
        expect(
          (await inspectService(service, { repoRoot: "/repo", env, listProcessCommandsImpl: foreign })).state,
        ).toBe("unreachable");
        // ...and it does not block the launcher from starting its own.
        const spawned: string[] = [];
        await startService(service, {
          repoRoot: "/repo",
          env,
          fetchImpl: unusedFetch,
          listProcessCommandsImpl: () => (spawned.length === 0 ? foreign() : [[7_001, "caffeinate -s"]]),
          processIsAliveImpl: (pid) => pid === 7_001,
          spawnImpl: ((command: string) => {
            spawned.push(command);
            return runningChild(7_001);
          }) as unknown as typeof spawn,
        });
        expect(spawned).toEqual(["caffeinate"]);
      },
    );

    it("only recognizes its own shape, never another caffeinate", () => {
      const { commandMatches } = managedService("awake");
      expect(commandMatches("caffeinate -s")).toBe(true);
      expect(commandMatches("/usr/bin/caffeinate -s")).toBe(true);
      expect(commandMatches("caffeinate -t 300")).toBe(false);
      expect(commandMatches("caffeinate -i -s make")).toBe(false);
      expect(commandMatches("vim caffeinate -s notes")).toBe(false);
    });

    it("restarts with the clankie service so login autostart brings it back", () => {
      expect(managedService("awake").restartsWith).toEqual(["clankie"]);
    });

    it("is off in a hosted loadout even when requested", async () => {
      const status = await inspectService(managedService("awake"), {
        repoRoot: "/repo",
        env: { ...(await optedIn()), CLANKIE_SERVICES: "clankie,relay" },
        fetchImpl: unusedFetch,
        listProcessCommandsImpl: noProcesses,
      });
      expect(status).toMatchObject({ state: "healthy", detail: "off in this loadout" });
    });
  });

  it("stops the fan-out at the first failure so downstream errors cannot mask it", async () => {
    const env = await stateEnv();
    const spawned: string[] = [];

    const outcomes = await restartTarget("all", {
      repoRoot: "/repo",
      env,
      listProcessCommandsImpl: noProcesses,
      listPortOwnersImpl: () => [],
      processIsAliveImpl: () => true,
      fetchImpl: (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch,
      spawnImpl: ((_command: string, args: string[]) => {
        spawned.push(args.join(" "));
        throw new Error("clankie spawn failed");
      }) as unknown as typeof spawn,
    });

    expect(spawned).toHaveLength(1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ id: "clankie", ok: false });
    expect(outcomes[0]?.error).toContain("clankie spawn failed");
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
      listPortOwnersImpl: () => [],
    });

    expect(outcomes.map((outcome) => outcome.id)).toEqual([
      "awake",
      "tunnel",
      "activity",
      "discord-user-session",
      "discord-bridge",
      "relay",
      "clankie",
    ]);
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
  });

  it("keeps stopping the rest after one service refuses, and says which failed", async () => {
    const env = await stateEnv();
    // A clankie service that is up but was started outside the launcher: it
    // must be reported, not killed, and it must not abort the other stops. The
    // live process is what makes it unownedly-running, not the health response.
    const outcomes = await stopTarget("all", {
      repoRoot: "/repo",
      env,
      fetchImpl: (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch,
      listProcessCommandsImpl: processList("node pnpm.mjs --filter @clankie/clankie start"),
      listPortOwnersImpl: (port) => (port === 4310 ? [9_900] : []),
    });

    expect(outcomes.map((outcome) => [outcome.id, outcome.ok])).toEqual([
      ["awake", true],
      ["tunnel", true],
      ["activity", true],
      ["discord-user-session", true],
      ["discord-bridge", true],
      ["relay", true],
      ["clankie", false],
    ]);
    expect(outcomes.find((outcome) => outcome.id === "clankie")?.error).toMatch(
      /not started by the clankie launcher/u,
    );
  });
});

describe("captain credential injection", () => {
  /**
   * Captures the env a service is spawned with.
   *
   * `startService` returns early when the service already probes healthy, so a
   * service under test has to look down until it is spawned and up afterwards —
   * otherwise nothing is ever launched and the assertion passes vacuously on an
   * env that was never captured.
   */
  function capturingSpawn(): {
    readonly spawnImpl: typeof spawn;
    readonly started: () => boolean;
    readonly envFor: () => NodeJS.ProcessEnv | undefined;
    readonly command: () => string | undefined;
    readonly args: () => readonly string[] | undefined;
  } {
    let captured: NodeJS.ProcessEnv | undefined;
    let capturedCommand: string | undefined;
    let capturedArgs: readonly string[] | undefined;
    let launched = false;
    const spawnImpl = ((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      captured = options.env;
      capturedCommand = command;
      capturedArgs = args;
      launched = true;
      return runningChild(9_700);
    }) as unknown as typeof spawn;
    return {
      spawnImpl,
      started: () => launched,
      envFor: () => captured,
      command: () => capturedCommand,
      args: () => capturedArgs,
    };
  }

  /** Service health that reports down until the process has been spawned. */
  function healthAfterStart(started: () => boolean): typeof fetch {
    return (async () => {
      if (!started()) throw new Error("connection refused");
      return Response.json({ ok: true, service: "clankie" });
    }) as unknown as typeof fetch;
  }

  it("gives the clankie service the shared captain secret and its presence runtime", async () => {
    const env = await stateEnv();
    const { spawnImpl, started, envFor } = capturingSpawn();

    await startService(managedService("clankie"), {
      repoRoot: "/repo",
      env,
      spawnImpl,
      captainToken: "clankie_cap_test",
      processIsAliveImpl: () => true,
      listProcessCommandsImpl: noProcesses,
      listPortOwnersImpl: () => [],
      fetchImpl: healthAfterStart(started),
    });

    expect(started()).toBe(true);
    expect(envFor()?.CLANKIE_CAPTAIN_TOKEN).toBe("clankie_cap_test");
    expect(envFor()?.CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE).toBe(
      "/repo/apps/discord-bridge/src/presence-runtime-module.ts",
    );
    expect(envFor()?.CLANKIE_DISCORD_USER_PRESENCE_RUNTIME_MODULE).toBe(
      "/repo/apps/discord-user-session/src/presence-runtime-module.ts",
    );
  });

  it("runs the compiled service and runtime modules from an installed release", async () => {
    const env = await stateEnv();
    const runtimeRoot = await mkdtemp(join(tmpdir(), "clankie-runtime-"));
    tempDirs.push(runtimeRoot);
    for (const path of [
      "libexec/node",
      "apps/clankie/src/index.js",
      "apps/discord-bridge/src/presence-runtime-module.js",
      "apps/discord-user-session/src/presence-runtime-module.js",
    ]) {
      const target = join(runtimeRoot, path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, "");
    }
    const captured = capturingSpawn();

    await startService(managedService("clankie"), {
      repoRoot: runtimeRoot,
      env,
      spawnImpl: captured.spawnImpl,
      processIsAliveImpl: () => true,
      listProcessCommandsImpl: noProcesses,
      listPortOwnersImpl: () => [],
      fetchImpl: healthAfterStart(captured.started),
    });

    expect(captured.command()).toBe(join(runtimeRoot, "libexec", "node"));
    expect(captured.args()).toEqual([join(runtimeRoot, "apps", "clankie", "src", "index.js")]);
    expect(captured.envFor()?.CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE).toBe(
      join(runtimeRoot, "apps", "discord-bridge", "src", "presence-runtime-module.js"),
    );
    expect(captured.envFor()?.CLANKIE_DISCORD_USER_PRESENCE_RUNTIME_MODULE).toBe(
      join(runtimeRoot, "apps", "discord-user-session", "src", "presence-runtime-module.js"),
    );
  });

  it("writes an opt-in CPU profile for the installed service with existing Node options", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "clankie-profile-"));
    tempDirs.push(runtimeRoot);
    await mkdir(join(runtimeRoot, "libexec"), { recursive: true });
    await mkdir(join(runtimeRoot, "apps/clankie/src"), { recursive: true });
    await writeFile(join(runtimeRoot, "libexec/node"), "");
    await writeFile(
      join(runtimeRoot, "apps/clankie/src/index.js"),
      "console.log(JSON.stringify({argv:process.execArgv,options:process.env.NODE_OPTIONS}));",
    );
    const env = {
      ...process.env,
      CLANKIE_CPU_PROFILE_DIR: "profiles with spaces",
      NODE_OPTIONS: "--no-warnings",
    };
    const service = managedService("clankie");
    const resolved = service.resolveProcess!({ repoRoot: runtimeRoot, env });
    expect(resolved.command).toBe(join(runtimeRoot, "libexec/node"));
    expect(service.commandMatches(`${resolved.command} ${resolved.args.join(" ")}`)).toBe(true);
    const result = await promisify(execFile)(process.execPath, [...resolved.args], { env });
    expect(JSON.parse(result.stdout)).toMatchObject({ options: "--no-warnings" });
    const profiles = await readdir(join(runtimeRoot, env.CLANKIE_CPU_PROFILE_DIR));
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatch(/\.cpuprofile$/u);
    const profile = JSON.parse(
      await readFile(join(runtimeRoot, env.CLANKIE_CPU_PROFILE_DIR, profiles[0]!), "utf8"),
    );
    expect(profile.nodes.length).toBeGreaterThan(0);
    expect(profile.endTime).toBeGreaterThan(profile.startTime);
    // Other service launches retain their ordinary command and arguments.
    expect(managedService("relay").resolveProcess!({ repoRoot: runtimeRoot, env })).toEqual({
      command: "pnpm",
      args: ["--filter", "@clankie/relay", "start"],
    });
  });

  it("profiles checkout Clankie through a controller without profiling its preparation", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-profile-checkout-"));
    tempDirs.push(root);
    const service = managedService("clankie");
    const resolved = service.resolveProcess!({
      repoRoot: root,
      env: { CLANKIE_CPU_PROFILE_DIR: "profiles" },
    });
    expect(resolved).toEqual({
      command: process.execPath,
      args: [join(root, "scripts/profile-clankie.mjs"), join(root, "profiles")],
    });
    expect(service.commandMatches(`${resolved.command} ${resolved.args.join(" ")}`)).toBe(true);
    expect(existsSync(join(root, "profiles"))).toBe(true);
    expect(service.resolveProcess!({ repoRoot: root, env: {} })).toEqual({
      command: "pnpm",
      args: ["--filter", "@clankie/clankie", "start"],
    });
  });

  it("runs the real checkout profiling controller with tsx and flushes its child profile on SIGTERM", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-profile-controller-"));
    tempDirs.push(root);
    const scripts = join(root, "scripts");
    const app = join(root, "apps/clankie");
    const profiles = join(root, "profiles");
    await mkdir(scripts, { recursive: true });
    await mkdir(join(app, "scripts"), { recursive: true });
    await mkdir(join(app, "src"), { recursive: true });
    await mkdir(profiles);
    await writeFile(join(app, "package.json"), '{"type":"module"}');
    await symlink(
      join(import.meta.dirname, "../../clankie/node_modules"),
      join(app, "node_modules"),
      "junction",
    );
    // Use the repository's real native preparation and real tsx loader. Only
    // the service fixture is small so this check cannot reach owner state.
    await writeFile(
      join(scripts, "profile-clankie.mjs"),
      await readFile(join(import.meta.dirname, "../../../scripts/profile-clankie.mjs")),
    );
    await writeFile(
      join(app, "scripts/profile-clankie.mjs"),
      await readFile(join(import.meta.dirname, "../../clankie/scripts/profile-clankie.mjs")),
    );
    const builder = pathToFileURL(join(import.meta.dirname, "../../../scripts/build-fleet-proof.mjs")).href;
    await writeFile(
      join(scripts, "build-fleet-proof.mjs"),
      `export { buildFleetProof } from ${JSON.stringify(builder)};`,
    );
    await writeFile(
      join(app, "src/index.ts"),
      'const marker: string = "ready"; process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000); function fixtureWork() { const until = performance.now() + 25; while (performance.now() < until) {} } fixtureWork(); console.log(JSON.stringify({marker,argv:process.execArgv}));',
    );
    const child = spawn(process.execPath, [join(scripts, "profile-clankie.mjs"), profiles], {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: join(root, ".config"),
        CLANKIE_STATE: join(root, ".clankie"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const ended = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    try {
      const ready = await Promise.race([
        new Promise<string>((resolve) => child.stdout.once("data", (chunk) => resolve(String(chunk)))),
        ended.then(() => {
          throw new Error(`profile controller exited before ready: ${stderr}`);
        }),
      ]);
      expect(JSON.parse(ready)).toMatchObject({ marker: "ready" });
      expect(JSON.parse(ready).argv).toContain("--cpu-prof");
      expect(JSON.parse(ready).argv.some((arg: string) => arg.startsWith("--inspect"))).toBe(false);
      child.kill("SIGTERM");
      expect(await ended).toBe(0);
      expect(stderr).toBe("");
      const names = await readdir(profiles);
      expect(names).toHaveLength(1);
      const profile = JSON.parse(await readFile(join(profiles, names[0]!), "utf8"));
      expect(
        profile.nodes.some((node: { callFrame: { url: string } }) =>
          node.callFrame.url.endsWith("/src/index.ts"),
        ),
      ).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await ended;
      }
    }
  }, 15000);

  it("omits the variable entirely when no credential could be brokered", async () => {
    const env = await stateEnv();
    const { spawnImpl, started, envFor } = capturingSpawn();

    await startService(managedService("clankie"), {
      repoRoot: "/repo",
      env,
      spawnImpl,
      processIsAliveImpl: () => true,
      listProcessCommandsImpl: noProcesses,
      fetchImpl: healthAfterStart(started),
      listPortOwnersImpl: () => [],
    });

    expect(started()).toBe(true);
    expect(envFor()).not.toHaveProperty("CLANKIE_CAPTAIN_TOKEN");
  });

  it("never lets the Discord bridge see the captain token", async () => {
    // The bridge throws on startup if this variable exists at all: its identity
    // is brokered separately as clankie_discord_bridge, and the captain's bearer
    // would hand a Discord-facing process the captain's own authority. The env
    // here already carries one, standing in for an operator who exported it.
    const env = await stateEnv();
    const { spawnImpl, started, envFor } = capturingSpawn();

    await startService(managedService("discord-bridge"), {
      repoRoot: "/repo",
      env: { ...env, CLANKIE_CAPTAIN_TOKEN: "leaked-from-the-operator-shell" },
      spawnImpl,
      captainToken: "clankie_cap_test",
      processIsAliveImpl: () => true,
      operatorToken: "operator-secret",
      // No bridge until one is spawned, then one that is running.
      listProcessCommandsImpl: () =>
        started() ? [[9_700, "node @clankie/discord-bridge start"] as const] : [],
      fetchImpl: (async () =>
        Response.json({
          schemaVersion: 1,
          sessions: [{ phase: "present", gatewayConnected: true, voiceGuildCount: 0, activityCount: 0 }],
        })) as unknown as typeof fetch,
    });

    expect(started()).toBe(true);
    expect(envFor()).toBeDefined();
    expect(envFor()).not.toHaveProperty("CLANKIE_CAPTAIN_TOKEN");
  });
});

describe("restart carries dependents", () => {
  it("restarts the bridge when the clankie service it claims against restarts", () => {
    // The failure this prevents: the service rebuilds presence from its event
    // store, the still-running bridge keeps a claim for the old revision, and
    // every reply it posts is rejected `discord_presence_live_claim_stale`.
    expect(resolveRestartTargets("clankie")).toEqual([
      "clankie",
      "relay",
      "discord-bridge",
      "discord-user-session",
      // Keep-awake follows the service, so the login-time `restart clankie`
      // brings it back after a reboot.
      "awake",
    ]);
  });

  it("leaves a leaf service on its own", () => {
    expect(resolveRestartTargets("activity")).toEqual(["activity"]);
  });

  it("restarts the relay with the service whose bearer it holds", () => {
    expect(resolveRestartTargets("relay")).toEqual(["relay"]);
    expect(resolveRestartTargets("clankie")).toContain("relay");
  });

  it("gives the relay its canonical port and the brokered captain bearer", () => {
    const env = managedService("relay").serviceEnv?.({
      env: {},
      repoRoot: "/repo",
      captainToken: "captain-secret",
    });
    expect(env?.CLANKIE_RELAY_PORT).toBe("4321");
    expect(env?.CLANKIE_CAPTAIN_TOKEN).toBe("captain-secret");
    const overridden = managedService("relay").serviceEnv?.({
      env: { CLANKIE_RELAY_PORT: "5555" },
      repoRoot: "/repo",
      captainToken: undefined,
    });
    expect(overridden?.CLANKIE_RELAY_PORT).toBe("5555");
    expect(overridden !== undefined && "CLANKIE_CAPTAIN_TOKEN" in overridden).toBe(false);
  });

  it("probes the relay health endpoint on its canonical port", async () => {
    const healthy = await managedService("relay").probe({
      env: {},
      fetchImpl: (async (input: unknown) => {
        expect(String(input)).toBe("http://127.0.0.1:4321/health");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch,
      operatorToken: undefined,
      record: undefined,
      matchingPids: [],
    });
    expect(healthy).toMatchObject({ state: "healthy" });
    const down = await managedService("relay").probe({
      env: {},
      fetchImpl: (async () => {
        throw new Error("refused");
      }) as typeof fetch,
      operatorToken: undefined,
      record: undefined,
      matchingPids: [],
    });
    expect(down).toMatchObject({ state: "unreachable" });
  });

  it("treats both Discord processes as one mutually-exclusive restart slot", () => {
    expect(resolveRestartTargets("discord-bridge")).toEqual(["discord-bridge", "discord-user-session"]);
    expect(resolveRestartTargets("discord-user-session")).toEqual(["discord-bridge", "discord-user-session"]);
  });

  it("keeps the full order for an explicit all", () => {
    expect(resolveRestartTargets("all")).toEqual(resolveTargets("all"));
  });

  it("does not widen a stop, which names exactly what it means", () => {
    expect(resolveTargets("clankie")).toEqual(["clankie"]);
  });
});

it("snapshots processes before concurrent health probes start", async () => {
  let scans = 0;
  let probing = false;
  const services = await inspectServices(["clankie", "relay"], {
    repoRoot: "/unused",
    env: await stateEnv(),
    listProcessCommandsImpl: () => {
      expect(probing).toBe(false);
      scans++;
      return [];
    },
    fetchImpl: (async () => {
      probing = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  expect(scans).toBe(1);
  expect(services.map((service) => service.state)).toEqual(["healthy", "healthy"]);
});
