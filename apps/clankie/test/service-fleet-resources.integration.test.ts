import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createServiceFleetResourceRuntime } from "../src/service-fleet-resources.ts";

it.each([{ VITEST: "true" }, { NODE_ENV: "test" }])(
  "isolates a marked service without a directory override: %j (VUH-2038)",
  async (env) => {
    const runtime = await createServiceFleetResourceRuntime({ policy: async () => undefined }, env);
    try {
      runtime.start();
      await runtime.simulators.tick();
      expect(runtime.status()?.leases).toEqual([]);
      expect((await runtime.simulators.externalDevices()).inventory).toEqual([]);
    } finally {
      await runtime.close();
    }
  },
);

it("isolates a fixture service and denies native simulator access (VUH-2038)", async () => {
  const root = await mkdtemp(join(tmpdir(), "service-resources-"));
  const directory = join(root, "registry");
  const runtime = await createServiceFleetResourceRuntime(
    { policy: async () => undefined },
    { VITEST: "true", CLANKIE_TEST_FLEET_RESOURCES_DIRECTORY: directory },
  );
  try {
    runtime.start();
    await runtime.simulators.tick();
    await runtime.refresh();
    await runtime.configure({
      heavySlots: 1,
      simulatorSlots: 0,
      simulatorIdleMs: 600_000,
      maxLoadRatio: 1.5,
      minAvailableMemoryMb: 4096,
      minFreeDiskGb: 20,
      warnFreeDiskGb: 200,
      warnFreeDiskPercent: 10,
    });
    expect((await runtime.simulators.externalDevices()).inventory).toEqual([]);
    expect(JSON.parse(await readFile(join(directory, "state.json"), "utf8")).leases).toEqual([]);
    const result = await runtime.simulators.plan({
      seatId: "fixture",
      occupantId: "fixture",
      deviceId: "00000000-0000-0000-0000-000000000001",
    });
    expect(result.outcome).toBe("rejected");
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses an override pointing into owner state, including a symlink (VUH-2038)", async () => {
  const root = await mkdtemp(join(tmpdir(), "service-resources-"));
  try {
    const owner = join(userInfo().homedir, ".clankie");
    await expect(
      createServiceFleetResourceRuntime(
        { policy: async () => undefined },
        {
          NODE_ENV: "test",
          CLANKIE_TEST_FLEET_RESOURCES_DIRECTORY: join(owner, "fleet-resources"),
        },
      ),
    ).rejects.toThrow("overlap the live registry");
    await symlink(userInfo().homedir, join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    await expect(
      createServiceFleetResourceRuntime(
        { policy: async () => undefined },
        {
          NODE_ENV: "test",
          CLANKIE_TEST_FLEET_RESOURCES_DIRECTORY: join(root, "alias", ".clankie", "fleet-resources"),
        },
      ),
    ).rejects.toThrow("overlap the live registry");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
