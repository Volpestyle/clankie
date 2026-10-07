import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "@clankie/settings";
import { afterEach, describe, expect, it } from "vitest";
import { runHeadlessCaptainCommand } from "../bin/headless-captain.ts";
import { runAwakeCommand } from "../src/command/awake.ts";
import { HEADLESS_NOUNS } from "../src/command/registry.ts";
import type { ExecFileImpl } from "../src/install-doctor.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function fixture(): Promise<{ readonly env: NodeJS.ProcessEnv; readonly settings: SettingsStore }> {
  const root = await mkdtemp(join(tmpdir(), "clankie-awake-test-"));
  tempDirs.push(root);
  return {
    env: {
      CLANKIE_CONTROL_PLANE_URL: "http://127.0.0.1:1",
      HOME: root,
      XDG_STATE_HOME: join(root, "state"),
      XDG_CONFIG_HOME: join(root, "config"),
    },
    settings: new SettingsStore(join(root, "config", "settings.json")),
  };
}

/** A Mac on battery with a one-minute sleep, and a record of every command asked of it. */
function fakePmset(source: "AC Power" | "Battery Power" = "Battery Power"): {
  readonly execFileImpl: ExecFileImpl;
  readonly calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    execFileImpl: async (command, args) => {
      calls.push([command, ...args]);
      if (command !== "pmset") throw Object.assign(new Error("not found"), { code: "ENOENT" });
      if (args[1] === "batt") return { stdout: `Now drawing from '${source}'\n`, stderr: "" };
      if (args[1] === "custom") {
        return { stdout: "Battery Power:\n sleep 1\nAC Power:\n sleep 0\n", stderr: "" };
      }
      return { stdout: "Listed by owning process:\n", stderr: "" };
    },
  };
}

function runningChild(pid: number): ChildProcess {
  return Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    pid,
    kill: () => true,
    unref: () => {},
  }) as unknown as ChildProcess;
}

const quiet = { write: () => undefined };

describe.skipIf(process.platform !== "darwin")("clankie awake", () => {
  it("is a launcher noun with a usage error for anything else", async () => {
    expect(HEADLESS_NOUNS).toContain("awake");
    const { env, settings } = await fixture();
    await expect(
      runAwakeCommand(["sideways"], { repoRoot: "/repo", localSetup: true, env, settings }),
    ).rejects.toThrow(/Usage: clankie awake/u);
  });

  it("reports off by default with the sleep warning, and starts nothing", async () => {
    const { env, settings } = await fixture();
    const pmset = fakePmset();
    const spawned: string[] = [];
    const result = await runAwakeCommand([], {
      repoRoot: "/repo",
      localSetup: true,
      env,
      settings,
      stderr: quiet,
      execFileImpl: pmset.execFileImpl,
      listProcessCommandsImpl: () => [],
      spawnImpl: ((command: string) => {
        spawned.push(command);
        return runningChild(1);
      }) as unknown as typeof spawn,
    });

    expect(spawned).toEqual([]);
    expect(result).toMatchObject({
      keepAwake: false,
      service: { state: "healthy" },
      power: { state: "sleep_allowed", source: "battery", sleepAfterMinutes: 1 },
    });
    expect(result.power.advice).toContain("clankie awake on");
  });

  it("on stores the opt-in, runs `caffeinate -s`, and never writes a power setting", async () => {
    const { env, settings } = await fixture();
    const pmset = fakePmset("AC Power");
    const spawned: (readonly string[])[] = [];
    const result = await runAwakeCommand(["on"], {
      repoRoot: "/repo",
      localSetup: true,
      env,
      settings,
      stderr: quiet,
      execFileImpl: pmset.execFileImpl,
      listProcessCommandsImpl: () => (spawned.length === 0 ? [] : [[4_242, "caffeinate -s"]]),
      processIsAliveImpl: (pid) => pid === 4_242,
      spawnImpl: ((command: string, args: readonly string[]) => {
        spawned.push([command, ...args]);
        return runningChild(4_242);
      }) as unknown as typeof spawn,
    });

    expect((await settings.load()).host.keepAwake).toBe(true);
    expect(spawned).toEqual([["caffeinate", "-s"]]);
    expect(result).toMatchObject({ keepAwake: true, service: { state: "healthy", pid: 4_242 } });
    // Read-only: pmset is only ever asked with `-g`, never told to change anything.
    expect(pmset.calls.every(([command, flag]) => command === "pmset" && flag === "-g")).toBe(true);
  });

  it("off clears the opt-in and stops the caffeinate the launcher started", async () => {
    const { env, settings } = await fixture();
    const alive = new Set<number>();
    const killed: number[] = [];
    const shared = {
      repoRoot: "/repo",
      localSetup: true,
      env,
      settings,
      stderr: quiet,
      execFileImpl: fakePmset().execFileImpl,
      listProcessCommandsImpl: () => [...alive].map((pid) => [pid, "caffeinate -s"] as const),
      readProcessCommandImpl: () => "caffeinate -s",
      processIsAliveImpl: (pid: number) => alive.has(pid),
      killImpl: (pid: number) => {
        killed.push(pid);
        alive.delete(pid);
      },
    };
    await runAwakeCommand(["on"], {
      ...shared,
      spawnImpl: (() => {
        alive.add(6_001);
        return runningChild(6_001);
      }) as unknown as typeof spawn,
    });

    const result = await runAwakeCommand(["off"], shared);

    expect(killed).toEqual([6_001]);
    expect((await settings.load()).host.keepAwake).toBe(false);
    expect(result).toMatchObject({ keepAwake: false, service: { state: "healthy" } });
  });

  it("dispatches through the headless launcher as JSON", async () => {
    const { env } = await fixture();
    let out = "";
    const code = await runHeadlessCaptainCommand(["awake", "status", "--local-setup"], {
      repoRoot: "/repo",
      env,
      stdout: { write: (chunk: string) => ((out += chunk), true) },
      stderr: quiet,
      execFileImpl: fakePmset().execFileImpl,
      listProcessCommandsImpl: () => [],
    });
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ ok: true, keepAwake: false, power: { source: "battery" } });
  });
});
