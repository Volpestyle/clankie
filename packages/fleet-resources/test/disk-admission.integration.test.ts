import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createResourceGovernor } from "../src/governor.ts";
import { defaultResourcePolicy } from "../src/model.ts";
import { FleetResourceSnapshotSchema } from "../../protocol/src/fleet-resources.ts";

it("real filesystem disk observations hold all heavy lanes and resume after the floor is lowered", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-disk-admission-"));
  const governor = createResourceGovernor({
    directory: join(root, "registry"),
    // Only disk is observed here; unrelated host memory/load cannot mask it.
    // The sampler still reads real statfs when disk fields are omitted.
    probe: async () => ({ loadRatio: 0, cpuRatio: 0, availableMemoryMb: 65_536 }),
  });
  try {
    const policy = {
      ...defaultResourcePolicy(),
      maxLoadRatio: 16,
      minAvailableMemoryMb: 0,
      minFreeDiskGb: 1_048_576,
      warnFreeDiskGb: 1_048_576,
    };
    await governor.configure(policy);
    const disk = FleetResourceSnapshotSchema.parse(await governor.snapshot()).pressure;
    expect(disk.reason).toBe("disk");
    expect(disk.freeDiskGb).toBeGreaterThan(0);
    expect(disk.totalDiskGb).toBeGreaterThanOrEqual(disk.freeDiskGb!);
    expect(disk.diskWarning).toBe(true);
    for (const lane of ["full", "light", "server"] as const) {
      const marker = join(root, lane);
      const stop = new AbortController();
      const args =
        lane === "light"
          ? [
              "-e",
              "require('node:fs').writeFileSync(process.argv[1], '')",
              marker,
              "vitest",
              "run",
              "disk.test.ts",
            ]
          : ["-e", "require('node:fs').writeFileSync(process.argv[1], '')", marker];
      const status = await governor.runHeavy(process.execPath, args, {
        server: lane === "server",
        signal: stop.signal,
        onWait: (snapshot) => {
          expect(snapshot.pressure.reason).toBe("disk");
          const queued =
            lane === "light"
              ? snapshot.lightQueue
              : lane === "server"
                ? snapshot.serverQueue
                : snapshot.queue;
          expect(queued).toHaveLength(1);
          stop.abort();
        },
      });
      expect(status).toBe(130);
      expect(
        await access(marker).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    }
    await governor.configure({ ...policy, minFreeDiskGb: 0, warnFreeDiskGb: 0, warnFreeDiskPercent: 0 });
    const marker = join(root, "resumed");
    expect(
      await governor.runHeavy(process.execPath, [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], '')",
        marker,
      ]),
    ).toBe(0);
    expect(
      await access(marker).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
    process.stdout.write(`Real disk proof: ${JSON.stringify(disk)}\n`);
  } finally {
    await governor.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
