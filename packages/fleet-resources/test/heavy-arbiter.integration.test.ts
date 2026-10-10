// One arbiter's view of pressure → FIFO grants → real heavy child processes (VUH-2080).
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createResourceGovernor } from "../src/governor.ts";
import { processIdentity } from "../src/process.ts";
import { ResourceStore } from "../src/store.ts";
import { defaultResourcePolicy, type ResourcePressureInput } from "../src/model.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const calm: ResourcePressureInput = { loadRatio: 0.1, cpuRatio: 0.1, availableMemoryMb: 65_536 };
/** What the waiter that wedged the fleet saw: a shim made it count 3 of 18 cores. */
const wrong: ResourcePressureInput = { loadRatio: 99, cpuRatio: 1, availableMemoryMb: 65_536 };
/** Appends its name to the order file, so the test reads admission order. */
const record = "require('node:fs').appendFileSync(process.argv[1], process.argv[2] + '\\n')";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "clankie-heavy-arbiter-"));
  const order = join(directory, "order");
  await writeFile(order, "");
  const governors: ReturnType<typeof createResourceGovernor>[] = [];
  const jobs: Promise<number>[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];
  cleanup.push(async () => {
    for (const timer of timers) clearInterval(timer);
    await Promise.allSettled([...jobs, ...passes]);
    for (const governor of governors) await governor.close();
    await rm(directory, { recursive: true, force: true });
  });
  const governor = (view: ResourcePressureInput) => {
    const created = createResourceGovernor({
      directory,
      probe: async () => ({ ...view }),
      heavyJobSettleMs: 0,
    });
    governors.push(created);
    return created;
  };
  await governor(calm).configure({ ...defaultResourcePolicy(), heavySlots: 1, minAvailableMemoryMb: 0 });
  const run = (waiter: ReturnType<typeof createResourceGovernor>, name: string) => {
    const job = waiter.runHeavy(process.execPath, ["-e", record, order, name], { holderId: name });
    jobs.push(job);
    return job;
  };
  const queued = async (count: number) => {
    const deadline = Date.now() + 10_000;
    while ((await governors[0]!.snapshot()).queue.length !== count) {
      if (Date.now() > deadline) throw new Error(`expected ${count} queued`);
      await delay(25);
    }
  };
  /** Runs an arbiter loop the way the service does. */
  const passes = new Set<Promise<unknown>>();
  /** Runs an arbiter loop the way the service does. */
  const arbiter = (view: ResourcePressureInput) => {
    const judge = governor(view);
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      const pass = judge
        .arbitrate()
        .catch(() => undefined)
        .finally(() => {
          running = false;
          passes.delete(pass);
        });
      passes.add(pass);
    }, 100);
    timers.push(timer);
    return () => clearInterval(timer);
  };
  const ran = async () => (await readFile(order, "utf8")).split("\n").filter(Boolean);
  return { directory, governor, run, queued, arbiter, ran };
}

it("a waiter with a wrong view of the machine cannot hold the FIFO while an arbiter judges", async () => {
  const f = await fixture();
  const misjudged = f.run(f.governor(wrong), "misjudged");
  await f.queued(1);
  const behind = f.run(f.governor(calm), "behind");
  await f.queued(2);
  // Alone, the misjudging head holds everyone: that is the 2026-10-10 wedge.
  await delay(1_500);
  expect(await f.ran()).toEqual([]);
  f.arbiter(calm);
  expect(await misjudged).toBe(0);
  expect(await behind).toBe(0);
  // Granted in queue order, one at a time under the single slot.
  expect(await f.ran()).toEqual(["misjudged", "behind"]);
});

it("while an arbiter judges the machine busy, a waiter that sees it calm does not admit itself", async () => {
  const f = await fixture();
  const stop = f.arbiter(wrong);
  await delay(300);
  const waiter = f.run(f.governor(calm), "eager");
  await f.queued(1);
  await delay(1_500);
  expect(await f.ran()).toEqual([]);
  // Once the arbiter stops, its heartbeat goes stale and the waiter judges for itself.
  stop();
  expect(await waiter).toBe(0);
  expect(await f.ran()).toEqual(["eager"]);
}, 20_000);

it("an arbiter never grants a waiter that cannot take a grant up; that waiter keeps judging for itself", async () => {
  const f = await fixture();
  // A waiter from before VUH-2080: a live owner's ticket with no grant marker.
  const owner = await processIdentity();
  const id = randomUUID();
  await new ResourceStore(f.directory).transaction((state) => {
    state.queue.push({
      id,
      token: randomUUID(),
      kind: "heavy",
      owner: owner!,
      queuedAtMs: Date.now(),
      executable: "node",
    });
  });
  const judge = f.governor(calm);
  for (let pass = 0; pass < 3; pass++) expect(await judge.arbitrate()).toBe(0);
  const snapshot = await judge.snapshot();
  expect(snapshot.leases).toEqual([]);
  expect(snapshot.queue.map((entry) => entry.id)).toEqual([id]);
});
