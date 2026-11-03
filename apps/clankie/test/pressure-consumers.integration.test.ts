import { execFile, spawn } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import {
  createResourceGovernor,
  defaultResourcePolicy,
  type ResourcePressureInput,
  type ResourceSnapshot,
} from "@clankie/fleet-resources";
import { createFleetResourceRuntime } from "../src/fleet-resource-runtime.ts";

const exec = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

/**
 * Real processes using real CPU, the real governor and the service's hire admission.
 * Only the pressure reading is chosen, so the test decides when the machine is "full".
 */
it("a pressure refusal names the top consumers, unleased work and who started it, and each permit is charged its CPU and memory (#332)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pressure-consumers-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const burn = join(root, "burn");
  await exec("cc", [
    "-O1",
    "-pthread",
    fileURLToPath(new URL("./helpers/pressure-consumers/burn.c", import.meta.url)),
    "-o",
    burn,
  ]);
  for (const name of ["claude", "vitest", "tsc", "foreignburn"]) await copyFile(burn, join(root, name));

  let sample: ResourcePressureInput = { loadRatio: 0.1, availableMemoryMb: 64_000 };
  const governor = createResourceGovernor({ directory: join(root, "governor"), probe: async () => sample });
  const policy = { ...defaultResourcePolicy(), heavySlots: 2 };
  const resources = await createFleetResourceRuntime({ policy: async () => policy, governor });
  resources.bindSeats({
    resolve: async () => undefined,
    proof: async () => undefined,
    isLocalFleet: async () => true,
  } as unknown as Parameters<typeof resources.bindSeats>[0]);
  cleanups.push(async () => {
    await resources.close?.();
    await governor.close();
  });

  // Held work: a permit for seat w1:p9 running `tsc`, spinning for 20 s.
  const held = governor.runHeavy(join(root, "tsc"), ["20"], { seatId: "w1:p9", holderId: "pressure-test" });
  cleanups.push(() =>
    held.then(
      () => undefined,
      () => undefined,
    ),
  );
  // Unleased work: a "worker" (claude) starting a test run outside `clankie heavy`.
  const outside = spawn(join(root, "claude"), [join(root, "vitest"), "20"], { stdio: "ignore" });
  // Foreign work: a process no agent started (orphaned to launchd, as this test itself
  // runs under an agent harness), whose name must not leave the Mac.
  const foreign = {
    pid: Number(
      (
        await exec("/bin/sh", ["-c", `"${join(root, "foreignburn")}" 20 >/dev/null 2>&1 & echo $!`])
      ).stdout.trim(),
    ),
  };
  cleanups.push(async () => {
    outside.kill("SIGKILL");
    try {
      process.kill(foreign.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  });
  const permit = (snapshot: ResourceSnapshot) =>
    [...snapshot.leases, ...snapshot.lightLeases, ...(snapshot.serverLeases ?? [])].find(
      (lease) => lease.seatId === "w1:p9",
    );
  await expect.poll(async () => permit(await governor.snapshot())?.pid, { timeout: 15_000 }).toBeDefined();

  // The machine fills up. The kernel's CPU average takes a few seconds to climb.
  sample = { loadRatio: 9, availableMemoryMb: 64_000 };
  let snapshot!: ResourceSnapshot;
  const named = (executable: string) => snapshot.consumers?.find((entry) => entry.executable === executable);
  for (const deadline = Date.now() + 15_000; ;) {
    snapshot = await governor.snapshot();
    if (
      named("vitest") &&
      named("tsc") &&
      named("foreignburn") &&
      (permit(snapshot)?.processUsage?.cpuPercent ?? 0) > 50
    )
      break;
    if (Date.now() > deadline) break;
    await delay(1_000);
  }
  expect(snapshot.pressure.healthy).toBe(false);
  expect(named("vitest"), JSON.stringify(snapshot.consumers)).toMatchObject({
    pid: expect.any(Number),
    startedBy: { executable: "claude", pid: outside.pid },
  });
  expect(named("vitest")).not.toHaveProperty("holder");
  // The local snapshot names everything, foreign work included.
  expect(named("foreignburn"), JSON.stringify(snapshot.consumers)).toMatchObject({ pid: foreign.pid });
  expect(named("foreignburn")).not.toHaveProperty("startedBy");
  expect(named("tsc")).toMatchObject({ holder: { seatId: "w1:p9", executable: "tsc" } });
  // Each permit is charged its own process group, as `clankie fleet resources` shows.
  expect(permit(snapshot)?.processUsage).toMatchObject({
    cpuPercent: expect.any(Number),
    rssBytes: expect.any(Number),
    processes: expect.any(Number),
  });
  expect(permit(snapshot)!.processUsage!.cpuPercent).toBeGreaterThan(50);
  expect(snapshot.loadRetryAfterMs).toBeGreaterThan(0);

  // A hire refused for memory names them; a load-queued hire is told the same.
  sample = { loadRatio: 0.1, availableMemoryMb: 10 };
  const refused = await resources.admitHire({}).then(
    () => "admitted",
    (error: Error) => error.message,
  );
  expect(refused).toContain("Local hire refused: available memory 10 MiB");
  expect(refused).toMatch(/Top consumers: .*vitest PID \d+ \(unleased, started under claude PID \d+\)/u);
  expect(refused).toMatch(/tsc PID \d+ \(\w+ permit of seat w1:p9\)/u);
  // The refusal is the hire result's detail, which connected apps read: no foreign executable
  // names, only an anonymous sum of everything no agent started.
  const foreignNames = (await governor.snapshot())
    .consumers!.filter((consumer) => !consumer.holder && !consumer.startedBy)
    .map((consumer) => consumer.executable);
  expect(foreignNames).toContain("foreignburn");
  for (const name of foreignNames) expect(refused).not.toContain(name);
  expect(refused).toMatch(/\d+ other process(es)?, \d+% CPU, [\d.]+ (MiB|GiB)/u);
  sample = { loadRatio: 9, availableMemoryMb: 64_000 };
  const queued = await resources.admitHire({});
  expect(queued).toMatch(/Machine load is high.*Top consumers: .*vitest PID/u);
  expect(queued).not.toContain("foreignburn");
});
