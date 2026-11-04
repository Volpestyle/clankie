import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { applyLauncherEnvironment, managedService } from "../bin/services.ts";
import { restartService, startService, stopService, type ManagedService } from "../bin/service-supervisor.ts";
import { cpuProfileStatus, runCpuProfileCommand } from "../src/command/cpu-profile.ts";

// The real launcher, a real child, a real SIGTERM and Node's real profiler. Only
// the entrypoint is a stand-in, and the process table holds nothing but the
// stand-in, so the machine's own service can never be matched or stopped.
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const profiles = async (directory: string) =>
  existsSync(directory)
    ? (await readdir(directory)).filter((file) => file.endsWith(".cpuprofile")).length
    : 0;

async function installedService() {
  const root = await mkdtemp(join(tmpdir(), "clankie-cpu-profile-"));
  roots.push(root);
  await mkdir(join(root, "libexec"));
  await mkdir(join(root, "apps/clankie/src"), { recursive: true });
  await symlink(process.execPath, join(root, "libexec/node"));
  await writeFile(
    join(root, "apps/clankie/src/index.js"),
    `const { writeFileSync } = require("node:fs");
     process.on("SIGTERM", () => process.exit(0));
     writeFileSync(${JSON.stringify(join(root, "up"))}, String(process.pid));
     setInterval(() => {}, 1000);`,
  );
  await chmod(join(root, "apps/clankie/src/index.js"), 0o755);
  const settingsFile = join(root, "settings.json");
  const launch = () => ({ XDG_STATE_HOME: root, CLANKIE_SETTINGS_FILE: settingsFile, PATH: "/usr/bin:/bin" });
  const upPid = () => (existsSync(join(root, "up")) ? Number(readFileSync(join(root, "up"), "utf8")) : 0);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const service: ManagedService = {
    ...managedService("clankie"),
    prepare: async () => {},
    probe: async ({ record }) =>
      record !== undefined && record.pid === upPid() && alive(record.pid)
        ? { state: "healthy", detail: "fixture" }
        : { state: "unreachable", detail: "fixture" },
  };
  const options = (env: NodeJS.ProcessEnv) => ({
    repoRoot: root,
    env,
    captainToken: "fixture",
    listProcessCommandsImpl: () => [],
    // The machine's own service holds the default port; this launcher must not see it.
    listPortOwnersImpl: () => [],
    // Nor reach it: a health probe on the default port would find it up.
    fetchImpl: (async () => {
      throw new Error("no service here");
    }) as typeof fetch,
  });
  return { root, launch, service, options };
}

it("stays on across restarts started with no profiling in their environment, until turned off", async () => {
  const { root, launch, service, options } = await installedService();
  const directory = join(root, "profiles with spaces");

  expect(await runCpuProfileCommand(["on", directory], options(launch()))).toMatchObject({
    running: false,
    directory: null,
    configured: directory,
    appliesAt: "the service's next start",
  });

  // A fresh launcher each time, as each `clankie restart` is: the setting alone carries it.
  const fromSettings = async () => {
    const env: NodeJS.ProcessEnv = launch();
    await applyLauncherEnvironment(env);
    return env;
  };
  const first = await startService(service, options(await fromSettings()));
  expect(cpuProfileStatus({ configured: directory, service: first })).toEqual({
    running: true,
    directory,
    configured: directory,
  });
  expect(await profiles(directory)).toBe(0);

  const second = await restartService(service, options(await fromSettings()));
  expect(second.pid).not.toBe(first.pid);
  expect(await profiles(directory)).toBe(1);
  expect(cpuProfileStatus({ configured: directory, service: second }).running).toBe(true);

  const third = await restartService(service, options(await fromSettings()));
  expect(await profiles(directory)).toBe(2);
  expect(cpuProfileStatus({ configured: directory, service: third }).directory).toBe(directory);

  // Turned off, the running service keeps its profiler until its next start.
  await runCpuProfileCommand(["off"], options(launch()));
  expect(cpuProfileStatus({ configured: undefined, service: third })).toEqual({
    running: true,
    directory,
    configured: null,
  });
  const fourth = await restartService(service, options(await fromSettings()));
  expect(await profiles(directory)).toBe(3);
  expect(cpuProfileStatus({ configured: undefined, service: fourth })).toEqual({
    running: false,
    directory: null,
    configured: null,
  });
  await stopService(service, options(await fromSettings()));
  expect(await profiles(directory)).toBe(3);
});

it("lets one start's exported directory win without changing the setting", async () => {
  const { root, launch, options } = await installedService();
  const stored = join(root, "stored");
  await runCpuProfileCommand(["on", stored], options(launch()));
  const env: NodeJS.ProcessEnv = { ...launch(), CLANKIE_CPU_PROFILE_DIR: "/tmp/one-start" };
  await applyLauncherEnvironment(env);
  expect(env.CLANKIE_CPU_PROFILE_DIR).toBe("/tmp/one-start");
  const fromSettings: NodeJS.ProcessEnv = launch();
  await applyLauncherEnvironment(fromSettings);
  expect(fromSettings.CLANKIE_CPU_PROFILE_DIR).toBe(stored);
});

it("says it does not know when a service is up but no process can be read", () => {
  const configured = "/profiles";
  expect(cpuProfileStatus({ configured, service: { state: "healthy" } }).running).toBeNull();
  expect(cpuProfileStatus({ configured, service: { state: "unreachable" } }).running).toBe(false);
  expect(cpuProfileStatus({ configured, service: undefined }).running).toBe(false);
  expect(
    cpuProfileStatus({
      configured,
      service: { state: "healthy", pid: 1 },
      readCommand: () => "node --cpu-prof --cpu-prof-dir=/a b/c --disable-sigusr1 /entry.js",
    }),
  ).toEqual({ running: true, directory: "/a b/c", configured });
});

it("refuses a malformed command", async () => {
  const { launch, options } = await installedService();
  for (const args of [["on"], ["sideways"], ["status", "extra"], ["off", "now"]])
    await expect(runCpuProfileCommand(args, options(launch()))).rejects.toThrow(
      /Usage: clankie cpu-profile/u,
    );
});
