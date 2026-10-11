// One arbiter's view of pressure → FIFO grants → real heavy child processes (VUH-2080).
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
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
  const governor = (view: ResourcePressureInput | Error) => {
    const created = createResourceGovernor({
      directory,
      probe: async () => {
        if (view instanceof Error) throw view;
        return { ...view };
      },
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
  expect(judge.arbitration()?.heads).toEqual([
    expect.objectContaining({ ticketId: id, lane: "full", pid: process.pid, marked: false, admits: true }),
  ]);
  const snapshot = await judge.snapshot();
  expect(snapshot.leases).toEqual([]);
  expect(snapshot.queue.map((entry) => entry.id)).toEqual([id]);
});

it("unavailable pressure is unknown admission, while an empty queue is known idle", async () => {
  const f = await fixture();
  const healthy = f.governor(calm);
  await healthy.arbitrate();
  expect(healthy.arbitration()?.heads).toEqual([]);
  const id = randomUUID();
  const owner = (await processIdentity())!;
  await new ResourceStore(f.directory).transaction((state) =>
    state.queue.push({
      id,
      token: randomUUID(),
      kind: "heavy",
      owner,
      queuedAtMs: Date.now(),
    }),
  );
  await healthy.arbitrate();
  expect(healthy.arbitration()?.heads[0]?.admits).toBe(true);
  const blind = f.governor(new Error("fixture pressure observation unavailable"));
  expect(await blind.arbitrate()).toBe(0);
  expect(blind.arbitration()).toBeUndefined();
  expect((await new ResourceStore(f.directory).read()).queue[0]?.id).toBe(id);
});

it("a waiter whose grant marker was pruned before it enqueued is still granted, in order", async () => {
  const f = await fixture();
  const marks = join(f.directory, "grants");
  // The 2026-10-11 wedge: the arbiter's prune ran between a waiter writing its
  // marker and enqueueing, so the queued head had no marker and all waited.
  const release = join(f.directory, "release");
  const holding = f
    .governor(calm)
    .runHeavy(process.execPath, [
      "-e",
      "const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync(process.argv[1]))clearInterval(t)},20)",
      release,
    ]);
  f.arbiter(calm);
  const waiter = f.run(f.governor(calm), "unmarked");
  await f.queued(1);
  for (const name of await readdir(marks)) await rm(join(marks, name), { force: true });
  await writeFile(release, "");
  expect(await holding).toBe(0);
  expect(await waiter).toBe(0);
  expect(await f.ran()).toEqual(["unmarked"]);
});

it("an arbiter keeps a fresh marker whose ticket is not queued yet, and prunes a stale one", async () => {
  const f = await fixture();
  const marks = join(f.directory, "grants");
  await mkdir(marks, { recursive: true });
  // A queued ticket from an older client makes the arbiter take its full pass.
  const owner = await processIdentity();
  await new ResourceStore(f.directory).transaction((state) => {
    state.queue.push({
      id: randomUUID(),
      token: randomUUID(),
      kind: "heavy",
      owner: owner!,
      queuedAtMs: Date.now(),
      executable: "node",
    });
  });
  const enqueueing = randomUUID();
  const abandoned = randomUUID();
  await writeFile(join(marks, enqueueing), "");
  await writeFile(join(marks, abandoned), "");
  const old = new Date(Date.now() - 3_600_000);
  await utimes(join(marks, abandoned), old, old);
  await f.governor(calm).arbitrate();
  expect((await readdir(marks)).sort()).toEqual([enqueueing]);
});
