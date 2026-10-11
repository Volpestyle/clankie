import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { processIdentity } from "@clankie/fleet-resources";
import { ResourceStore } from "../../../packages/fleet-resources/src/store.ts";
import { createServiceFleetResourceRuntime } from "../src/service-fleet-resources.ts";
import { FleetProgressObserver } from "../src/fleet-progress.ts";

async function until(test: () => boolean | Promise<boolean>) {
  const end = Date.now() + 15_000;
  while (!(await test())) {
    if (Date.now() > end) throw Error("Heavy progress fixture did not settle");
    await delay(20);
  }
}

it("alerts for a real live unmarked head only after consecutive eligible verdicts; pressure waits stay quiet", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-progress-heavy-"));
  const directory = join(root, "registry");
  const runtime = await createServiceFleetResourceRuntime(
    { policy: async () => undefined },
    { NODE_ENV: "test", CLANKIE_TEST_FLEET_RESOURCES_DIRECTORY: directory },
  );
  const alerts = join(root, "alerts.jsonl");
  const options = {
    path: join(root, "incidents.json"),
    sources: [{ prefix: "heavy", read: async () => runtime.progress() }],
    notify: async (text: string) => {
      await appendFile(alerts, JSON.stringify(text) + "\n");
      return true;
    },
    onError: (error: unknown) => {
      throw error;
    },
  };
  let observer = new FleetProgressObserver(options);
  try {
    // Private registry, actual host pressure and exact native process birth.
    // This is the old-client/deleted-marker FIFO wedge; no live fleet edits.
    await runtime.configure({
      heavySlots: 1,
      simulatorSlots: 0,
      simulatorIdleMs: 600_000,
      maxLoadRatio: 16,
      minAvailableMemoryMb: 1_048_576,
    });
    const ticketId = randomUUID();
    const owner = (await processIdentity())!;
    const store = new ResourceStore(directory);
    await store.transaction((state) =>
      state.queue.push({
        id: ticketId,
        token: randomUUID(),
        kind: "heavy",
        owner,
        seatId: "fixture-lead-seat",
        holderId: "fixture-ticket-owner",
        executable: "node",
        queuedAtMs: Date.now() - 61_000,
      }),
    );
    runtime.start();
    await until(() => {
      try {
        return runtime.progress().length === 1;
      } catch {
        return false;
      }
    });
    await delay(1_100);
    expect(runtime.progress()[0]?.stalled).toBe(false);
    await observer.observe();
    await expect(readFile(alerts, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await runtime.configure({
      heavySlots: 1,
      simulatorSlots: 0,
      simulatorIdleMs: 600_000,
      maxLoadRatio: 16,
      minAvailableMemoryMb: 0,
    });
    // First eligible pass is not enough; the next pass proves it remains queued.
    await until(
      () =>
        runtime.progress()[0]?.message.includes(ticketId) === true && runtime.progress()[0]?.stalled === true,
    );
    await observer.observe();
    await until(async () => JSON.parse(await readFile(options.path, "utf8"))[0]?.alert === "submitted");
    observer.stop();
    observer = new FleetProgressObserver(options);
    await observer.observe();
    const opening = (await readFile(alerts, "utf8")).trim().split("\n");
    expect(opening).toHaveLength(1);
    expect(JSON.parse(opening[0]!)).toContain(ticketId);
    expect(JSON.parse(opening[0]!)).toContain("fixture-lead-seat");
    expect(JSON.parse(opening[0]!)).toContain("grant marker is absent");
    await store.transaction((state) => {
      state.queue = [];
    });
    await until(() => runtime.progress().length === 0);
    await observer.observe();
    await until(async () => JSON.parse(await readFile(options.path, "utf8"))[0]?.recovery === "submitted");
    expect((await readFile(alerts, "utf8")).trim().split("\n")).toHaveLength(2);
  } finally {
    observer.stop();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
