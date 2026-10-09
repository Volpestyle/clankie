import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { FleetResourceSnapshotSchema } from "../../protocol/src/fleet-resources.ts";
import { createResourceGovernor } from "../src/governor.ts";
import { defaultResourcePolicy } from "../src/model.ts";
import { observeSimulatorUsage, simulatorUsageFor } from "../src/simulator-usage.ts";

it.skipIf(process.platform !== "darwin")(
  "charges a device process tree to its holder through the kernel and resource API schema",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "clankie-simulator-usage-"));
    const deviceId = randomUUID().toUpperCase();
    // Real kernel processes, no simulator boot and no dependency on another worker's device.
    const executable = join(directory, "launchd_sim");
    await promisify(execFile)("/usr/bin/clang", [
      new URL("./fixtures/simulator-usage.c", import.meta.url).pathname,
      "-o",
      executable,
    ]);
    const root = spawn(
      executable,
      [`/CoreSimulator/Devices/${deviceId}/data/var/run/launchd_bootstrap.plist`],
      { stdio: "ignore" },
    );
    await once(root, "spawn");
    const governor = createResourceGovernor({
      directory: join(directory, "registry"),
      probe: async () => ({ loadRatio: 0, availableMemoryMb: 65536 }),
    });
    try {
      await governor.configure({ ...defaultResourcePolicy(), heavySlots: 1 });
      const admitted = await governor.tryAcquireSimulator({
        seatId: "fixture-seat",
        occupantId: "fixture-occupant",
        holderId: "fixture-task",
        externalActive: async () => 0,
      });
      if (!admitted.admitted) throw Error("Fixture admission refused");
      await governor.updateSimulator(admitted.lease.id, admitted.lease.token, { deviceId, phase: "booted" });
      // Earlier tests may have populated the bounded diagnostic cache.
      await delay(5100);
      const first = FleetResourceSnapshotSchema.parse(await governor.snapshot());
      const lease = first.leases.find((row) => row.id === admitted.lease.id)!;
      expect(lease.holderId).toBe("fixture-task");
      expect(lease.deviceId).toBe(deviceId);
      expect(lease.usage?.status).toBe("available");
      expect(lease.usage?.processCount).toBeGreaterThanOrEqual(2);
      expect(lease.usage?.footprintBytes).toBeGreaterThan(0);
      expect(lease.usage?.rssBytes).toBeGreaterThan(0);
      expect(lease.usage?.cpuTimeMs).toBeGreaterThan(90);
      expect(lease.usage?.cpuPercent).toBeUndefined();
      await delay(5100);
      const second = FleetResourceSnapshotSchema.parse(await governor.snapshot());
      const usage = second.leases.find((row) => row.id === admitted.lease.id)!.usage!;
      expect(usage.cpuPercent).toBeGreaterThan(0);
      expect(usage.intervalMs).toBeGreaterThan(0);
      expect(simulatorUsageFor(await observeSimulatorUsage(), randomUUID())).toMatchObject({
        status: "unavailable",
      });
      await governor.releaseSimulator(admitted.lease.id, admitted.lease.token);
      expect((await governor.snapshot()).leases).toHaveLength(0);
    } finally {
      const exited = once(root, "exit");
      if (root.exitCode === null && root.signalCode === null) {
        root.kill("SIGTERM");
        await exited;
      }
      await governor.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  20000,
);
