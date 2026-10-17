import { spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearRecoveryIntent,
  GIVE_UP_AFTER,
  readRecoveryRecord,
  recoverServices,
  recoveryAlertedPath,
  recoveryRecordPath,
  summarizeRecovery,
} from "../bin/service-recovery.ts";
import { serviceStatePath, withServiceLock, type ServiceId } from "../bin/service-supervisor.ts";
import type { ServiceOutcome, ServiceRegistryOptions } from "../bin/services.ts";
import { alertRecoveredCrash } from "../../clankie/src/crash-report-alert.ts";

const live: number[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const pid of live.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "clankie-recovery-"));
  roots.push(root);
  const env: NodeJS.ProcessEnv = {
    HOME: join(root, "home"),
    CLANKIE_STATE_HOME: join(root, "state"),
    PATH: process.env.PATH ?? "",
    // Probes of a live stub must never reach an installed service's default ports.
    CLANKIE_CONTROL_PLANE_URL: `http://127.0.0.1:${String(await closedPort())}`,
    CLANKIE_RELAY_PORT: String(await closedPort()),
    CLANKIE_ACTIVITY_PORT: String(await closedPort()),
  };
  await mkdir(join(root, "state", "clankie"), { recursive: true });
  await mkdir(join(root, "home"), { recursive: true });
  const registry: ServiceRegistryOptions = { repoRoot: root, env };
  return { root, env, registry };
}

/** A loopback port nothing listens on: a probe there is refused at once. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A real service process: runs until killed, or exits at once like a crash. */
async function runStub(crash: boolean): Promise<number> {
  const child = spawn(process.execPath, ["-e", crash ? "process.exit(1)" : "setInterval(() => {}, 1e6)"], {
    stdio: "ignore",
  });
  const pid = child.pid!;
  if (crash) await new Promise((resolve) => child.once("exit", resolve));
  else live.push(pid);
  child.unref();
  return pid;
}

/** What a launcher start leaves behind: the pid record for the process it spawned. */
async function record(env: NodeJS.ProcessEnv, id: ServiceId, pid: number): Promise<void> {
  await writeFile(serviceStatePath(id, env), `${JSON.stringify({ version: 1, id, pid })}\n`, { mode: 0o600 });
}

/** Stands in for the dependency-ordered restart: spawns a real replacement and records it. */
function restarter(env: NodeJS.ProcessEnv, crash = false) {
  const calls: ServiceId[] = [];
  return {
    calls,
    restart: async (id: ServiceId): Promise<readonly ServiceOutcome[]> => {
      calls.push(id);
      const pid = await runStub(crash);
      if (crash) {
        // A start that died before it was healthy removes its own record.
        await rm(serviceStatePath(id, env), { force: true });
        return [{ id, label: id, ok: false, error: `${id} exited with code 1` }];
      }
      await record(env, id, pid);
      return [{ id, label: id, ok: true, state: "healthy", pid }];
    },
  };
}

describe("launcher crash recovery", () => {
  it("restarts a service whose recorded process died, records why, and leaves a live one alone", async () => {
    const { env, registry } = await sandbox();
    await writeFile(
      join(env.CLANKIE_STATE_HOME!, "clankie", "clankie.log"),
      "booting\nError: Socket timeout\n    at TLSSocket.<anonymous>\nExit status 1\n",
    );
    await record(env, "clankie", await runStub(true));
    const stub = restarter(env);

    const pass = await recoverServices(registry, { restart: stub.restart, updateHeld: () => false });
    expect(pass.actions.map((action) => [action.id, action.action])).toEqual([["clankie", "restarted"]]);
    expect(stub.calls).toEqual(["clankie"]);
    const crash = readRecoveryRecord("clankie", env).crashes.at(-1)!;
    expect(crash).toMatchObject({ restart: "restarted" });
    expect(crash.logTail).toContain("Error: Socket timeout");
    expect(summarizeRecovery(env)).toEqual([
      expect.objectContaining({
        id: "clankie",
        state: "recovered",
        crashes: 1,
        lastError: "Error: Socket timeout",
      }),
    ]);

    // The replacement is alive: the next tick does nothing.
    const again = await recoverServices(registry, { restart: stub.restart, updateHeld: () => false });
    expect(again.actions).toEqual([]);
    expect(stub.calls).toEqual(["clankie"]);
  });

  it("never restarts a deliberately stopped service, during an update, or while another operation runs", async () => {
    const { env, registry } = await sandbox();
    const stub = restarter(env);

    // A deliberate stop removed the record: nothing to recover.
    expect(
      (await recoverServices(registry, { restart: stub.restart, updateHeld: () => false })).actions,
    ).toEqual([]);

    await record(env, "clankie", await runStub(true));
    // An accepted update owns the process graph.
    expect(await recoverServices(registry, { restart: stub.restart, updateHeld: () => true })).toEqual({
      ok: true,
      skipped: "update",
      actions: [],
    });
    // Another launcher operation holds the service lock.
    const busy = await withServiceLock(env, async () =>
      recoverServices(registry, { restart: stub.restart, updateHeld: () => false }),
    );
    expect(busy).toEqual({ ok: true, skipped: "busy", actions: [] });
    expect(stub.calls).toEqual([]);
  });

  it("backs off a crash loop, gives up after five, tells the owner once, and resumes after a deliberate restart", async () => {
    const { env, registry } = await sandbox();
    let clock = Date.parse("2026-10-06T23:51:00Z");
    const notices: string[] = [];
    const stub = restarter(env, true);
    const options = {
      restart: stub.restart,
      updateHeld: () => false,
      now: () => clock,
      notify: async (text: string) => {
        notices.push(text);
      },
    };
    await record(env, "clankie", await runStub(true));

    const actions: string[] = [];
    for (let tick = 0; tick < 20; tick++) {
      const pass = await recoverServices(registry, options);
      actions.push(...pass.actions.map((action) => action.action));
      clock += 30_000;
    }
    // Every failed restart counts; waits grow between them; the loop stops at five.
    expect(stub.calls.length).toBeLessThan(GIVE_UP_AFTER);
    expect(actions).toContain("waiting");
    expect(actions.filter((action) => action === "gave_up")).toHaveLength(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/crashed 5 times in 30 minutes and was left stopped/u);
    expect(summarizeRecovery(env, clock)).toEqual([
      expect.objectContaining({ id: "clankie", state: "gave_up" }),
    ]);

    // Left stopped: later ticks neither restart nor notify again.
    const calls = stub.calls.length;
    await recoverServices(registry, options);
    expect(stub.calls).toHaveLength(calls);
    expect(notices).toHaveLength(1);

    // The owner's restart clears the give-up; a later crash is recovered again.
    clearRecoveryIntent(["clankie"], env);
    expect(readRecoveryRecord("clankie", env).gaveUpAt).toBeUndefined();
    const healthy = restarter(env);
    await record(env, "clankie", await runStub(true));
    clock += 1_000;
    const resumed = await recoverServices(registry, { ...options, restart: healthy.restart });
    expect(resumed.actions.map((action) => action.action)).toEqual(["restarted"]);
  });

  // VUH-2393: a live process that answers nothing is as gone as a dead one.
  it("restarts a live service whose real probe keeps failing, only after a bounded streak, and says why", async () => {
    const { env, registry } = await sandbox();
    let clock = Date.parse("2026-10-17T12:00:00Z");
    const stub = restarter(env);
    const options = { restart: stub.restart, updateHeld: () => false, now: () => clock };
    // The relay's process is alive, but nothing answers its health endpoint.
    const wedged = await runStub(false);
    await record(env, "relay", wedged);

    const actions: string[] = [];
    for (let pass = 0; pass < 3; pass++) {
      actions.push(...(await recoverServices(registry, options)).actions.map((action) => action.action));
      clock += 60_000;
    }
    // Three failed probes over two minutes are not yet a hang.
    expect(actions).toEqual([]);
    expect(readRecoveryRecord("relay", env).unhealthy).toMatchObject({ pid: wedged, probes: 3 });

    // A pass skipped for longer than the streak gap (the Mac slept) starts the count again.
    clock += 5 * 60_000;
    await recoverServices(registry, options);
    expect(readRecoveryRecord("relay", env).unhealthy).toMatchObject({ probes: 1 });
    for (let pass = 0; pass < 3; pass++) {
      clock += 60_000;
      actions.push(...(await recoverServices(registry, options)).actions.map((action) => action.action));
    }
    expect(actions).toEqual(["restarted"]);
    expect(stub.calls).toEqual(["relay"]);
    const crash = readRecoveryRecord("relay", env).crashes.at(-1)!;
    expect(crash).toMatchObject({ pid: wedged, cause: "unhealthy", restart: "restarted" });
    expect(crash.reason).toMatch(
      /^health probe unreachable for 180 s \(4 probes\) while the process was alive$/u,
    );
    expect(readRecoveryRecord("relay", env).unhealthy).toBeUndefined();
    expect(summarizeRecovery(env, clock)).toEqual([
      expect.objectContaining({ id: "relay", state: "recovered", lastError: crash.reason }),
    ]);
  });

  it("the restarted service reports each crash to the owner exactly once", async () => {
    const { env, registry } = await sandbox();
    await writeFile(join(env.CLANKIE_STATE_HOME!, "clankie", "clankie.log"), "Error: Socket timeout\n");
    await record(env, "clankie", await runStub(true));
    await recoverServices(registry, { restart: restarter(env).restart, updateHeld: () => false });

    const sent: string[] = [];
    const notify = async (text: string) => {
      sent.push(text);
      return true;
    };
    expect(await alertRecoveredCrash(recoveryRecordPath("clankie", env), notify)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(
      /^clankie crashed and the launcher restarted it .*Last error: Error: Socket timeout/u,
    );
    expect(JSON.parse(await readFile(recoveryAlertedPath("clankie", env), "utf8"))).toHaveProperty("through");

    // Booting again with nothing new says nothing.
    expect(await alertRecoveredCrash(recoveryRecordPath("clankie", env), notify)).toBe(false);
    expect(sent).toHaveLength(1);
  });
});
