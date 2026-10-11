// Explicit pressure → shared admission → real native arbiter and fallback runner FIFO.
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { createResourceGovernor } from "../src/governor.ts";
import { defaultResourcePolicy } from "../src/model.ts";
import { processIdentity } from "../src/process.ts";
import { ResourceStore } from "../src/store.ts";

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean) {
  const end = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > end) throw new Error("Full progress native boundary timed out");
    await delay(50);
  }
}
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );
const hold = `
const fs = require('node:fs'); fs.writeFileSync(process.argv[1], 'started');
const timer = setInterval(() => { if (fs.existsSync(process.argv[2])) clearInterval(timer); }, 20);
`;
const holdWithLeftover = `
const fs=require('node:fs');
require('node:child_process').spawn(process.execPath, ['-e',
  "const fs=require('node:fs');fs.writeFileSync(process.argv[1],'started');const t=setInterval(()=>{if(fs.existsSync(process.argv[2]))clearInterval(t)},20)",
  process.argv[1], process.argv[3]], {stdio:'ignore'}).unref();
const timer=setInterval(()=>{if(fs.existsSync(process.argv[2]))clearInterval(timer)},20);
`;
async function fixture(availableMemoryMb = 65_536) {
  const root = await mkdtemp(join(tmpdir(), "clankie-full-progress-"));
  const directory = join(root, "registry");
  // Admission preconditions are explicit: shared CI can be below the owner's
  // memory floor or idle. Native process births, runners, journals, grants and
  // leftover cleanup remain real. Both clients observe the same pressure.
  const probe = async () => ({ loadRatio: 2.25, cpuRatio: 0.9, availableMemoryMb });
  const governor = createResourceGovernor({ directory, probe });
  const service = createResourceGovernor({ directory, probe });
  // Initially at the exact thrash cap; busyPolicy opens bounded progress.
  const policy = { ...defaultResourcePolicy(), heavySlots: 4, maxLoadRatio: 1.125 };
  const stop = new AbortController();
  const runs: Promise<number>[] = [];
  const files: string[] = [];
  const start = (name: string, script = hold) => {
    const started = join(root, `${name}.started`),
      release = join(root, `${name}.release`),
      cleanupRelease = join(root, `${name}.cleanup-release`);
    files.push(release, cleanupRelease);
    const job = governor.runHeavy(process.execPath, ["-e", script, started, release, cleanupRelease], {
      holderId: name,
      signal: stop.signal,
    });
    runs.push(job);
    return { job, started, release, cleanupRelease };
  };
  const busyPolicy = async (minAvailableMemoryMb = 4096) => {
    policy.maxLoadRatio = 1.5;
    await governor.configure({ ...policy, minAvailableMemoryMb });
    const busy = await governor.snapshot();
    expect(busy.pressure.reason).toBe("load");
    expect(busy.pressure.loadRatio).toBeLessThan(2 * policy.maxLoadRatio);
    return busy;
  };
  return {
    directory,
    governor,
    service,
    policy,
    start,
    busyPolicy,
    async close() {
      stop.abort();
      await Promise.all(files.map((file) => writeFile(file, "")));
      await governor.close();
      await service.close();
      await Promise.allSettled(runs);
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("a busy machine admits one full job and holds its follower through running and real leftover cleanup", async () => {
  const f = await fixture();
  let servicePass: Promise<number> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    // Queue both real waiters before opening the memory floor, with load
    // between the normal and thrash guards after busyPolicy takes effect.
    await f.governor.configure({ ...f.policy, minAvailableMemoryMb: 1_048_576 });
    const first = f.start("progress-first", holdWithLeftover);
    await until(
      () => f.governor.snapshot(),
      (status) => status.queue.length === 1,
    );
    const second = f.start("progress-second");
    const queued = await until(
      () => f.governor.snapshot(),
      (status) => status.queue.length === 2,
    );
    expect(queued.pressure.reason).toBe("load");
    expect(queued.queue.map((entry) => entry.holderId)).toEqual(["progress-first", "progress-second"]);
    await f.service.arbitrate();
    timer = setInterval(() => {
      servicePass ??= f.service.arbitrate().finally(() => {
        servicePass = undefined;
      });
    }, 100);
    await f.busyPolicy();
    await until(() => exists(first.started), Boolean);
    const held = await f.governor.snapshot();
    expect(held.pressure.reason).toBe("load");
    expect(held.capacity.used).toBe(1);
    expect(held.queue.map((entry) => entry.holderId)).toEqual(["progress-second"]);
    expect(await exists(second.started)).toBe(false);
    const sampled = await until(
      async () => f.service.arbitration(),
      (pass) => pass?.heads.some((head) => head.holderId === "progress-second" && !head.admits) === true,
    );
    await delay(1000);
    expect((await f.governor.snapshot()).capacity.used).toBe(1);
    expect(await exists(second.started)).toBe(false);
    await writeFile(first.release, "");
    const cleanup = await until(
      () => f.governor.snapshot(),
      (status) =>
        status.leases.some((lease) => lease.holderId === "progress-first" && lease.state === "leftovers"),
    );
    expect(cleanup.capacity.used).toBe(1);
    expect(cleanup.pressure.reason).toBe("load");
    expect(cleanup.pressure.loadRatio).toBeLessThan(2 * f.policy.maxLoadRatio);
    expect(cleanup.queue.map((entry) => entry.holderId)).toEqual(["progress-second"]);
    await delay(1000);
    expect(await exists(second.started)).toBe(false);
    const cleanupSample = await until(
      async () => f.service.arbitration(),
      (pass) => pass?.heads.some((head) => head.holderId === "progress-second" && !head.admits) === true,
    );
    await writeFile(first.cleanupRelease, "");
    expect(await first.job).toBe(0);
    await until(() => exists(second.started), Boolean);
    const next = await f.governor.snapshot();
    expect(next.pressure.reason).toBe("load");
    expect(next.capacity.used).toBe(1);
    expect(next.queue).toHaveLength(0);
    process.stdout.write(
      `Full progress proof: ${JSON.stringify({
        loadRatio: held.pressure.loadRatio,
        memoryMb: held.pressure.availableMemoryMb,
        ceiling: f.policy.maxLoadRatio,
        held: held.capacity.used,
        queued: held.queue.length,
        sampledFollowerAdmits: sampled!.heads.find((head) => head.holderId === "progress-second")!.admits,
        cleanupHeld: cleanup.capacity.used,
        cleanupState: cleanup.leases[0]!.state,
        sampledCleanupAdmits: cleanupSample!.heads.find((head) => head.holderId === "progress-second")!
          .admits,
        successorHeld: next.capacity.used,
      })}\n`,
    );
    await writeFile(second.release, "");
    expect(await second.job).toBe(0);
  } finally {
    if (timer) clearInterval(timer);
    await servicePass;
    await f.close();
  }
}, 60_000);

it("the empty-lane exception still refuses a memory-floor breach at high load", async () => {
  const f = await fixture(2048);
  try {
    await f.governor.configure({ ...f.policy, minAvailableMemoryMb: 1_048_576 });
    await f.busyPolicy(4096);
    const job = f.start("progress-low-memory");
    const queued = await until(
      () => f.governor.snapshot(),
      (status) => status.queue.length === 1,
    );
    expect(queued.pressure.reason).toBe("load");
    expect(queued.pressure.availableMemoryMb).toBeLessThan(queued.policy.minAvailableMemoryMb);
    expect(await f.service.arbitrate()).toBe(0);
    const sampled = f.service.arbitration()!;
    expect(sampled.heads.find((head) => head.holderId === "progress-low-memory")?.admits).toBe(false);
    await delay(1000);
    const blocked = await f.governor.snapshot();
    expect(blocked.capacity.used).toBe(0);
    expect(blocked.queue).toHaveLength(1);
    expect(await exists(job.started)).toBe(false);
    process.stdout.write(
      `Memory floor proof: ${JSON.stringify({
        loadRatio: blocked.pressure.loadRatio,
        ceiling: f.policy.maxLoadRatio,
        memoryMb: blocked.pressure.availableMemoryMb,
        floorMb: blocked.policy.minAvailableMemoryMb,
        held: blocked.capacity.used,
        queued: blocked.queue.length,
        sampledAdmits: sampled.heads.find((head) => head.holderId === "progress-low-memory")!.admits,
      })}\n`,
    );
  } finally {
    await f.close();
  }
}, 30_000);

it("an exception-admitted real starting grant holds its second full waiter", async () => {
  const f = await fixture();
  const id = randomUUID(),
    token = randomUUID();
  const store = new ResourceStore(f.directory);
  try {
    await f.governor.configure({ ...f.policy, minAvailableMemoryMb: 1_048_576 });
    await f.busyPolicy();
    // A real live client whose service grant has not yet been consumed by a
    // runner. Use its native birth, mark before enqueue, and let the real
    // arbiter create the starting lease; no lease or identity is fabricated.
    const owner = (await processIdentity())!;
    await mkdir(join(f.directory, "grants"), { recursive: true });
    await writeFile(join(f.directory, "grants", id), "");
    await store.transaction((state) => {
      state.queue.push({
        id,
        token,
        kind: "heavy",
        owner,
        queuedAtMs: Date.now(),
        executable: "node",
        holderId: "progress-starting",
      });
    });
    await f.service.arbitrate();
    expect((await f.governor.snapshot()).leases).toEqual([
      expect.objectContaining({ id, state: "starting", holderId: "progress-starting" }),
    ]);
    const follower = f.start("progress-starting-follower");
    await until(
      () => f.governor.snapshot(),
      (status) => status.queue.length === 1,
    );
    expect(await f.service.arbitrate()).toBe(0);
    expect(
      f.service.arbitration()?.heads.find((head) => head.holderId === "progress-starting-follower")?.admits,
    ).toBe(false);
    await delay(1000);
    const held = await f.governor.snapshot();
    expect(held.pressure.reason).toBe("load");
    expect(held.pressure.loadRatio).toBeLessThan(2 * f.policy.maxLoadRatio);
    expect(held.leases[0]?.state).toBe("starting");
    expect(held.capacity.used).toBe(1);
    expect(held.queue).toHaveLength(1);
    expect(await exists(follower.started)).toBe(false);
    process.stdout.write(
      `Starting proof: ${JSON.stringify({ loadRatio: held.pressure.loadRatio, ceiling: f.policy.maxLoadRatio, held: held.capacity.used, state: held.leases[0]?.state, queued: held.queue.length })}\n`,
    );
    // Release only this fixture client's exact unconsumed grant.
    await store.transaction((state) => {
      state.leases = state.leases.filter((lease) => lease.id !== id || lease.token !== token);
    });
    await f.service.arbitrate();
    await until(() => exists(follower.started), Boolean);
    await writeFile(follower.release, "");
    expect(await follower.job).toBe(0);
  } finally {
    try {
      await store.transaction((state) => {
        state.leases = state.leases.filter((lease) => lease.id !== id || lease.token !== token);
      });
    } finally {
      store.close();
      await f.close();
    }
  }
}, 30_000);

it("an empty full lane still refuses load at the thrash cap", async () => {
  const f = await fixture();
  try {
    await f.governor.configure({ ...f.policy, minAvailableMemoryMb: 4096 });
    const job = f.start("progress-thrash");
    const queued = await until(
      () => f.governor.snapshot(),
      (status) => status.queue.length === 1,
    );
    expect(queued.pressure.reason).toBe("load");
    expect(queued.pressure.availableMemoryMb).toBeGreaterThanOrEqual(4096);
    expect(queued.pressure.loadRatio).toBe(2 * f.policy.maxLoadRatio);
    expect(await f.service.arbitrate()).toBe(0);
    await delay(1000);
    const blocked = await f.governor.snapshot();
    expect(blocked.capacity.used).toBe(0);
    expect(blocked.queue).toHaveLength(1);
    expect(f.service.arbitration()?.heads.find((head) => head.holderId === "progress-thrash")?.admits).toBe(
      false,
    );
    expect(await exists(job.started)).toBe(false);
    process.stdout.write(
      `Thrash proof: ${JSON.stringify({ loadRatio: blocked.pressure.loadRatio, ceiling: f.policy.maxLoadRatio, held: blocked.capacity.used, queued: blocked.queue.length })}\n`,
    );
  } finally {
    await f.close();
  }
}, 30_000);
