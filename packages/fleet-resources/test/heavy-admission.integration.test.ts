// Pressure sample → governor admission → real heavy child processes (VUH-2054).
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it } from "vitest";
import { createResourceGovernor } from "../src/governor.ts";
import { defaultResourcePolicy, type ResourcePressureInput } from "../src/model.ts";
import { baseHeavySlots, ResourcePressureSampler } from "../src/pressure.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
/** A heavy command that holds its permit until the test releases it. */
const hold = `
const fs = require("node:fs");
const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(timer); } }, 20);
`;

async function fixture(options: { heavyJobSettleMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "clankie-heavy-admission-"));
  const release = join(directory, "release");
  const machine: ResourcePressureInput = { loadRatio: 0.1, cpuRatio: 0.1, availableMemoryMb: 65_536 };
  const governor = createResourceGovernor({
    directory,
    probe: async () => ({ ...machine }),
    heavyJobSettleMs: options.heavyJobSettleMs ?? 0,
  });
  const jobs: Promise<number>[] = [];
  cleanup.push(async () => {
    await writeFile(release, "");
    await Promise.allSettled(jobs);
    await governor.close();
    await rm(directory, { recursive: true, force: true });
  });
  const policy = { ...defaultResourcePolicy(), maxLoadRatio: 10, minAvailableMemoryMb: 0 };
  const base = baseHeavySlots(policy);
  const start = (count: number, onWait?: () => void) => {
    for (let index = 0; index < count; index++)
      jobs.push(governor.runHeavy(process.execPath, ["-e", hold, release], onWait ? { onWait } : {}));
  };
  const held = async (count: number) => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const snapshot = await governor.snapshot();
      if (snapshot.capacity.used === count) return snapshot;
      if (Date.now() > deadline)
        throw new Error(`expected ${count} heavy leases, saw ${snapshot.capacity.used}`);
      await delay(50);
    }
  };
  return { directory, governor, machine, policy, base, start, held };
}

it("heavySlots is a ceiling: a quiet machine runs more jobs than the base slots, and no more than the ceiling", async () => {
  const f = await fixture();
  await f.governor.configure({ ...f.policy, heavySlots: f.base + 2 });
  f.start(f.base + 3);
  const snapshot = await f.held(f.base + 2);
  expect(snapshot.queue).toHaveLength(1);
  await delay(1_000);
  expect((await f.governor.snapshot()).capacity.used).toBe(f.base + 2);
});

it("above the base slots, measured CPU and memory headroom hold the queue until the machine has room", async () => {
  const f = await fixture();
  await f.governor.configure({ ...f.policy, heavySlots: f.base + 1 });
  f.machine.cpuRatio = 0.8;
  let waits = 0;
  f.start(f.base + 1, () => waits++);
  await f.held(f.base);
  await delay(1_000);
  expect((await f.governor.snapshot()).capacity.used).toBe(f.base);
  expect(waits).toBeGreaterThan(0);
  // CPU is quiet, but the extra job would leave too little memory above the floor.
  f.machine.cpuRatio = 0.1;
  f.machine.availableMemoryMb = 4_096;
  await delay(1_000);
  expect((await f.governor.snapshot()).capacity.used).toBe(f.base);
  f.machine.availableMemoryMb = 65_536;
  await f.held(f.base + 1);
});

it("a job admitted under a minute ago is charged its full core share before load shows it", async () => {
  const f = await fixture({ heavyJobSettleMs: 60_000 });
  await f.governor.configure({ ...f.policy, heavySlots: f.base + 1 });
  // Half the machine is busy: room for one more job once the base jobs show their real use.
  f.machine.loadRatio = 0.5;
  f.machine.cpuRatio = 0.5;
  f.start(f.base);
  await f.held(f.base);
  const cancelled = new AbortController();
  const marker = join(f.directory, "extra-ran");
  let waited = false;
  const extra = await f.governor.runHeavy(
    process.execPath,
    ["-e", "require('node:fs').writeFileSync(process.argv[1], '')", marker],
    {
      signal: cancelled.signal,
      onWait: () => {
        waited = true;
        cancelled.abort();
      },
    },
  );
  expect({ extra, waited, ran: await exists(marker) }).toEqual({ extra: 130, waited: true, ran: false });
  // The same registry with settled jobs admits it.
  const settled = createResourceGovernor({
    directory: f.directory,
    probe: async () => ({ ...f.machine }),
    heavyJobSettleMs: 0,
  });
  try {
    expect(await settled.runHeavy(process.execPath, ["-e", ""])).toBe(0);
  } finally {
    await settled.close();
  }
});

it("the real sampler reports busy cores the kernel counts", async () => {
  const policy = { ...defaultResourcePolicy(), maxLoadRatio: 16, minAvailableMemoryMb: 0 };
  const burners = Array.from(
    { length: Math.max(1, Math.ceil(availableParallelism() / 2)) },
    () => new Worker("const end = Date.now() + 4000; while (Date.now() < end);", { eval: true }),
  );
  try {
    // The first sample opens the CPU window; the second measures across it.
    const sampler = new ResourcePressureSampler();
    expect((await sampler.sample(policy)).healthy).toBe(true);
    await delay(500);
    const sampled = await sampler.sample(policy);
    expect(sampled.healthy).toBe(true);
    // Half the cores spin; anything else on the machine only adds to it.
    expect(sampled.cpuRatio).toBeGreaterThanOrEqual(0.4);
    expect(sampled.cpuRatio).toBeLessThanOrEqual(1);
  } finally {
    await Promise.all(burners.map((burner) => burner.terminate()));
  }
});
