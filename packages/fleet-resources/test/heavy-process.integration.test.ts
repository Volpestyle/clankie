import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createResourceGovernor } from "../src/governor.ts";
import { defaultResourcePolicy } from "../src/model.ts";
import { processIdentity, resourceNativeHelperPath, resourcePython } from "../src/process.ts";
import { ResourceStore } from "../src/store.ts";

const driver = join(import.meta.dirname, "fixtures/heavy-driver.mjs");
const command = join(import.meta.dirname, "fixtures/heavy-command.mjs");
const registrationDriver = join(import.meta.dirname, "fixtures/registration-driver.mjs");
async function eventually<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeout = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error("Owned subprocess boundary was not reached");
    await delay(40);
  }
}
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "clankie-heavy-integration-"));
  const governor = createResourceGovernor({ directory });
  await governor.configure({
    ...defaultResourcePolicy(),
    heavySlots: 1,
    maxLoadRatio: 10,
    minAvailableMemoryMb: 0,
  });
  const children: ChildProcess[] = [],
    completions = new Map<ChildProcess, Promise<number>>(),
    receipts: string[] = [];
  function start(seat: string, mode = "hold", exit = "0") {
    const receipt = join(directory, `${seat}.receipt`),
      release = join(directory, `${seat}.release`);
    const child = spawn(
      process.execPath,
      [
        driver,
        directory,
        seat,
        process.execPath,
        command,
        mode,
        receipt,
        mode === "exit" ? exit : release,
        directory,
        "Bearer-secret-must-not-enter-resource-journal",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HEAVY_SLOTS: "99", CLANKIE_STATE: join(directory, "worker-override") },
      },
    );
    const output: string[] = [];
    child.stdout?.on("data", (bytes) => output.push(String(bytes)));
    child.stderr?.on("data", (bytes) => output.push(String(bytes)));
    const done = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGKILL" ? 137 : 143)));
    });
    void done.catch(() => undefined);
    children.push(child);
    completions.set(child, done);
    receipts.push(receipt);
    return { child, done, receipt, release, output };
  }
  async function release(path: string) {
    await writeFile(path, "release");
  }
  async function close() {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const state = await new ResourceStore(directory).read();
    for (const lease of state.leases) {
      if (lease.kind !== "heavy" || !lease.runner) continue;
      const current = await processIdentity(lease.runner.pid);
      if (current?.startTime === lease.runner.startTime) process.kill(-lease.runner.pgid, "SIGKILL");
    }
    // Cleanup uses exact receipts from commands this fixture started, including
    // survivors of a killed runner; journal census bookkeeping is not authority.
    for (const receipt of receipts) {
      if (!(await exists(receipt))) continue;
      const proof = JSON.parse(await readFile(receipt, "utf8")) as { pid: number; startTime: string };
      const survivor = await processIdentity(proof.pid);
      if (survivor?.startTime === proof.startTime) process.kill(survivor.pid, "SIGKILL");
      await eventually(
        () => processIdentity(proof.pid),
        (current) => current?.startTime !== proof.startTime,
      );
    }
    await Promise.allSettled(completions.values());
    await governor.close();
    await rm(directory, { recursive: true, force: true });
  }
  return { directory, governor, start, release, close };
}

describe("machine shared heavy permits with actual OS children", () => {
  it("keeps eleven queued requests and their tickets through more than fifteen seconds of OS lock contention", async () => {
    const f = await fixture();
    let holder: ChildProcess | undefined;
    let held: ReturnType<typeof createInterface> | undefined;
    let holderDone: Promise<number | null> | undefined;
    try {
      const active = f.start("lock-active");
      await eventually(() => exists(active.receipt), Boolean, 30_000);
      const queued = Array.from({ length: 11 }, (_, i) => f.start(`lock-waiter-${i}`, "exit"));
      const before = await eventually(
        () => new ResourceStore(f.directory).read(),
        (state) => state.queue.length === queued.length,
        30_000,
      );
      holder = spawn(resourcePython, ["-I", resourceNativeHelperPath(), "lock", f.directory], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      holderDone = new Promise((resolve) => holder!.once("exit", resolve));
      held = createInterface({ input: holder.stdout! });
      expect((await held[Symbol.asyncIterator]().next()).done).toBe(false);
      // The real native holder has acquired flock. Every wrapper now polls the
      // same lock; the former spawn-to-exit watchdog killed those waiters at 15s.
      await delay(17_000);
      expect(queued.map((request) => request.child.exitCode)).toEqual(Array(11).fill(null));
      expect((await new ResourceStore(f.directory).read()).queue).toEqual(before.queue);
      holder.stdin!.end("{}\n");
      expect(await holderDone).toBe(0);
      await f.release(active.release);
      expect(await active.done).toBe(0);
      expect(await Promise.all(queued.map((request) => request.done))).toEqual(Array(11).fill(0));
      for (const request of queued) {
        expect(await exists(request.receipt)).toBe(true);
        expect(request.output.join("")).not.toContain("Fleet resource lock unavailable");
      }
      const after = await f.governor.snapshot();
      expect(after.queue).toEqual([]);
      expect(after.capacity.used).toBe(0);
    } finally {
      held?.close();
      holder?.stdin?.destroy();
      if (holder && holder.exitCode === null && holder.signalCode === null) holder.kill("SIGTERM");
      if (holderDone) await holderDone;
      await f.close();
    }
  }, 120_000);
  it("simulator admission never queues: a full pool and a disabled policy answer at once, leaving heavy order intact", async () => {
    const f = await fixture();
    try {
      const active = f.start("active");
      await eventually(() => exists(active.receipt), Boolean);
      const first = f.start("first");
      await eventually(
        () => f.governor.snapshot(),
        (value) => value.queue.some((entry) => entry.seatId === "first"),
      );
      const request = { seatId: "simulator", occupantId: "fixture-occupant", externalActive: async () => 0 };
      // Shared slot held by a real heavy runner: the answer names it instead of waiting.
      const blocked = await f.governor.tryAcquireSimulator(request);
      expect(blocked).toMatchObject({ admitted: false, reason: "shared_capacity" });
      if (blocked.admitted) throw new Error("unexpected admission");
      expect(blocked.snapshot.leases).toEqual([
        expect.objectContaining({ kind: "heavy", seatId: "active", pid: expect.any(Number) }),
      ]);
      await f.governor.configure({
        ...defaultResourcePolicy(),
        heavySlots: 1,
        simulatorSlots: 0,
        maxLoadRatio: 10,
        minAvailableMemoryMb: 0,
      });
      await expect(f.governor.tryAcquireSimulator(request)).rejects.toThrow(
        "Simulator leases are disabled by owner policy",
      );
      const last = f.start("last");
      await eventually(
        () => f.governor.snapshot(),
        (value) => value.queue.some((entry) => entry.seatId === "last"),
      );
      expect((await f.governor.snapshot()).queue.map((entry) => entry.seatId)).toEqual(["first", "last"]);
      await f.release(active.release);
      expect(await active.done).toBe(0);
      await eventually(() => exists(first.receipt), Boolean);
      await f.release(first.release);
      expect(await first.done).toBe(0);
      await eventually(() => exists(last.receipt), Boolean);
      await f.release(last.release);
      expect(await last.done).toBe(0);
      expect((await f.governor.snapshot()).capacity.used).toBe(0);
      expect(await f.governor.simulatorReservations()).toEqual([]);
    } finally {
      await f.close();
    }
  }, 30_000);
  it.each(["unregistered", "registered"] as const)(
    "never submits a command after its %s claim owner dies before execution permission",
    async (mode) => {
      const f = await fixture();
      const claim = join(f.directory, "claim.receipt"),
        ready = join(f.directory, "ready.receipt"),
        submitted = join(f.directory, "submitted.receipt");
      const wrapper = spawn(
        process.execPath,
        [registrationDriver, f.directory, mode, claim, ready, submitted],
        { stdio: "ignore" },
      );
      const done = new Promise<void>((resolve) => wrapper.once("exit", () => resolve()));
      try {
        await eventually(() => exists(mode === "registered" ? ready : claim), Boolean);
        wrapper.kill("SIGKILL");
        await done;
        await eventually(
          () => f.governor.snapshot(),
          (value) => value.capacity.used === 0,
        );
        if (mode === "unregistered") {
          const ref = JSON.parse(await readFile(claim, "utf8")) as { id: string; token: string };
          const late = spawn(
            resourcePython,
            ["-I", resourceNativeHelperPath(), "run", f.directory, ref.id, ref.token],
            { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
          );
          const failed = new Promise<number | null>((resolve) => late.once("exit", resolve));
          const replies = createInterface({ input: late.stdio[4] as Readable });
          (late.stdio[3] as Writable).write(
            `${JSON.stringify({ command: process.execPath, args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'submitted')", submitted] })}\ngo\n`,
          );
          expect(await failed).toBe(1);
          replies.close();
          (late.stdio[3] as Writable).destroy();
        }
        expect(await exists(submitted)).toBe(false);
      } finally {
        if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGKILL");
        await done;
        await f.close();
      }
    },
    20_000,
  );
  it("holds one owner policy across worker environments, admits FIFO, cancels a queued waiter, and stores no argv", async () => {
    const f = await fixture();
    try {
      const first = f.start("first");
      await eventually(() => exists(first.receipt), Boolean);
      const second = f.start("second");
      await eventually(
        () => f.governor.snapshot(),
        (value) => value.queue.some((entry) => entry.seatId === "second"),
      );
      const cancelled = f.start("cancelled");
      await eventually(
        () => f.governor.snapshot(),
        (value) => value.queue.some((entry) => entry.seatId === "cancelled"),
      );
      expect(await exists(second.receipt)).toBe(false);
      expect(await exists(cancelled.receipt)).toBe(false);
      cancelled.child.kill("SIGTERM");
      expect(await cancelled.done).toBe(143);
      expect((await f.governor.snapshot()).queue.map((entry) => entry.seatId)).toEqual(["second"]);
      await f.release(first.release);
      expect(await first.done).toBe(0);
      await eventually(() => exists(second.receipt), Boolean);
      expect((await f.governor.snapshot()).leases.map((entry) => entry.seatId)).toEqual(["second"]);
      expect(await readFile(join(f.directory, "state.json"), "utf8")).not.toContain("Bearer-secret");
      await f.release(second.release);
      expect(await second.done).toBe(0);
      expect((await f.governor.snapshot()).capacity).toMatchObject({ heavySlots: 1, used: 0 });
    } finally {
      await f.close();
    }
  }, 20_000);

  it("retains a real command when its wrapper is killed and admits the next waiter only after that group exits", async () => {
    const f = await fixture();
    try {
      const first = f.start("orphan");
      await eventually(() => exists(first.receipt), Boolean);
      first.child.kill("SIGKILL");
      expect(await first.done).toBe(137);
      expect((await f.governor.snapshot()).capacity.used).toBe(1);
      const second = f.start("after-orphan");
      await eventually(
        () => f.governor.snapshot(),
        (value) => value.queue.length === 1,
      );
      expect(await exists(second.receipt)).toBe(false);
      await f.release(first.release);
      await eventually(() => exists(second.receipt), Boolean);
      await f.release(second.release);
      expect(await second.done).toBe(0);
      expect((await f.governor.snapshot()).capacity.used).toBe(0);
    } finally {
      await f.close();
    }
  }, 20_000);

  it("retains a surviving process group after runner death rather than reclaiming only its dead PID", async () => {
    const f = await fixture();
    try {
      const first = f.start("runner-orphan");
      await eventually(() => exists(first.receipt), Boolean);
      const state = await new ResourceStore(f.directory).read();
      const lease = state.leases.find((entry) => entry.kind === "heavy")!;
      if (lease.kind !== "heavy" || !lease.runner) throw new Error("Owned runner absent");
      const proof = await processIdentity(lease.runner.pid);
      expect(proof?.startTime).toBe(lease.runner.startTime);
      await f.governor.snapshot();
      process.kill(lease.runner.pid, "SIGKILL");
      expect(await first.done).toBe(137);
      const { pid } = JSON.parse(await readFile(first.receipt, "utf8")) as { pid: number };
      expect(await processIdentity(pid)).toBeDefined();
      expect((await f.governor.snapshot()).capacity.used).toBe(1);
      const second = f.start("after-runner");
      await eventually(
        () => f.governor.snapshot(),
        (value) => value.queue.length === 1,
      );
      expect(await exists(second.receipt)).toBe(false);
      await f.release(first.release);
      await eventually(() => exists(second.receipt), Boolean);
      await f.release(second.release);
      expect(await second.done).toBe(0);
    } finally {
      await f.close();
    }
  }, 20_000);

  it("reuses an inherited verified permit for nested heavy and propagates the real exit status", async () => {
    const f = await fixture();
    try {
      const run = f.start("nested", "nested");
      expect(await run.done).toBe(17);
      const receipt = JSON.parse(await readFile(`${run.receipt}.nested`, "utf8")) as {
        code: number;
        snapshot: { capacity: { used: number }; queue: unknown[] };
      };
      expect(receipt.code).toBe(17);
      expect(receipt.snapshot.capacity.used).toBe(1);
      expect(receipt.snapshot.queue).toEqual([]);
      expect((await f.governor.snapshot()).capacity.used).toBe(0);
    } finally {
      await f.close();
    }
  }, 20_000);

  it("forwards termination to the exact owned command group and releases its permit after exit", async () => {
    const f = await fixture();
    try {
      const run = f.start("terminated");
      await eventually(() => exists(run.receipt), Boolean);
      const { pid } = JSON.parse(await readFile(run.receipt, "utf8")) as { pid: number };
      run.child.kill("SIGTERM");
      expect(await run.done).toBe(143);
      expect(await processIdentity(pid)).toBeUndefined();
      expect((await f.governor.snapshot()).capacity.used).toBe(0);
    } finally {
      await f.close();
    }
  }, 20_000);

  it("reclaims a dead starting incarnation without treating a reused live PID as its owner", async () => {
    const f = await fixture();
    try {
      const live = (await processIdentity())!;
      await new ResourceStore(f.directory).transaction((state) => {
        state.leases.push({
          id: randomUUID(),
          token: randomUUID(),
          kind: "heavy",
          state: "starting",
          executable: "node",
          createdAtMs: Date.now(),
          lastUsedAtMs: Date.now(),
          claimOwner: { ...live, startTime: `${live.startTime}-previous-incarnation` },
        });
      });
      expect((await f.governor.snapshot()).capacity.used).toBe(0);
      expect((await processIdentity())?.startTime).toBe(live.startTime);
      const run = f.start("after-stale", "exit", "23");
      expect(await run.done).toBe(23);
    } finally {
      await f.close();
    }
  }, 20_000);
});
