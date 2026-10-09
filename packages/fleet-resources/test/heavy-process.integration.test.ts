import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { afterEach, aroundEach, describe, expect, it } from "vitest";
import { createResourceGovernor } from "../src/governor.ts";
import { defaultResourcePolicy } from "../src/model.ts";
import {
  observeProcesses,
  processIdentity,
  resourceNativeHelperPath,
  resourcePython,
} from "../src/process.ts";
import { ResourceStore } from "../src/store.ts";
import { fixtureWork, withFixtureWork } from "../../../scripts/testing/fixture-work.ts";

aroundEach(withFixtureWork);
const fixtureCleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  fixtureWork().stop();
  await fixtureWork().drain();
  for (const close of fixtureCleanup.splice(0)) await close();
});

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
// A process terminating between native reads can be temporarily unobservable.
// Keep its ownership proof until a fresh observation confirms identity or exit.
async function confirmedIdentity(pid: number) {
  const observation = await eventually(
    async () => (await observeProcesses([pid])).get(pid)!,
    (observation) => observation.status !== "unknown",
  );
  return observation.status === "live" ? observation.identity : undefined;
}
async function fixture() {
  const lifetime = fixtureWork();
  return lifetime.run(async () => {
    const directory = await mkdtemp(join(tmpdir(), "clankie-heavy-integration-"));
    const rawGovernor = createResourceGovernor({ directory });
    const governor = lifetime.wrap(rawGovernor);
    await governor.configure({
      ...defaultResourcePolicy(),
      heavySlots: 1,
      maxLoadRatio: 10,
      minAvailableMemoryMb: 0,
    });
    const children: ChildProcess[] = [],
      births = new Map<ChildProcess, ReturnType<typeof processIdentity>>(),
      completions = new Map<ChildProcess, Promise<number>>(),
      drained = new Map<ChildProcess, Promise<void>>(),
      receipts: string[] = [];
    function own(create: () => ChildProcess) {
      lifetime.signal.throwIfAborted();
      const child = create();
      children.push(child);
      const birth = child.pid ? confirmedIdentity(child.pid) : Promise.resolve(undefined);
      void birth.catch(() => undefined);
      births.set(child, birth);
      const done = new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        // Tests distinguish wrapper exit from the surviving real command group.
        child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGKILL" ? 137 : 143)));
      });
      void done.catch(() => undefined);
      completions.set(child, done);
      drained.set(child, new Promise<void>((resolve) => child.once("close", () => resolve())));
      return child;
    }
    function start(seat: string, mode = "hold", exit = "0") {
      lifetime.signal.throwIfAborted();
      const receipt = join(directory, `${seat}.receipt`),
        release = join(directory, `${seat}.release`);
      const child = own(() =>
        spawn(
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
            // An orphan must never share the real heavy runner's group, even though
            // its governor journal already belongs to this private fixture.
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, HEAVY_SLOTS: "99", CLANKIE_STATE: join(directory, "worker-override") },
          },
        ),
      );
      const output: string[] = [];
      child.stdout?.on("data", (bytes) => output.push(String(bytes)));
      child.stderr?.on("data", (bytes) => output.push(String(bytes)));
      const done = completions.get(child)!;
      receipts.push(receipt);
      return { child, done, receipt, release, output };
    }
    async function release(path: string) {
      await lifetime.run(() => writeFile(path, "release"));
    }
    function killGroup(pgid: number, signal: NodeJS.Signals) {
      try {
        process.kill(-pgid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    let closing: Promise<void> | undefined;
    function close(): Promise<void> {
      return (closing ??= shutdown());
    }
    async function shutdown() {
      lifetime.signal.removeEventListener("abort", cancel);
      for (const child of children) {
        const birth = await births.get(child);
        const current = birth ? await confirmedIdentity(birth.pid) : undefined;
        if (birth && current?.startTime === birth.startTime && current.pgid === birth.pid)
          killGroup(birth.pgid, "SIGTERM");
      }
      const state = await new ResourceStore(directory).read();
      for (const lease of state.leases) {
        if (lease.kind !== "heavy" || !lease.runner) continue;
        const current = await confirmedIdentity(lease.runner.pid);
        if (current?.startTime === lease.runner.startTime && current.pgid === lease.runner.pgid)
          killGroup(lease.runner.pgid, "SIGKILL");
      }
      // Cleanup uses exact receipts from commands this fixture started, including
      // survivors of a killed runner; journal census bookkeeping is not authority.
      for (const receipt of receipts) {
        if (!(await exists(receipt))) continue;
        const proof = JSON.parse(await readFile(receipt, "utf8")) as {
          pid: number;
          pgid: number;
          startTime: string;
        };
        const survivor = await confirmedIdentity(proof.pid);
        if (survivor?.startTime === proof.startTime && survivor.pgid === proof.pgid)
          killGroup(proof.pgid, "SIGKILL");
        await eventually(
          async () => (await observeProcesses([proof.pid])).get(proof.pid)!,
          (observation) =>
            observation.status === "exited" ||
            (observation.status === "live" && observation.identity.startTime !== proof.startTime),
        );
      }
      await Promise.allSettled(completions.values());
      await Promise.all(drained.values());
      await rawGovernor.close();
      await rm(directory, { recursive: true, force: true });
    }
    const cancel = () => {
      void close().catch(() => undefined);
    };
    fixtureCleanup.push(close);
    lifetime.signal.addEventListener("abort", cancel, { once: true });
    if (lifetime.signal.aborted) cancel();
    return { directory, governor, start, release, close, own };
  });
}

describe("machine shared heavy permits with actual OS children", () => {
  it("cancellation drains private fixture groups without retaining the enclosing fleet permit", async () => {
    const f = await fixture();
    const enclosing = await processIdentity();
    const active = f.start("cancel-owned-active");
    await eventually(() => exists(active.receipt), Boolean);
    const waiting = f.start("cancel-owned-waiting", "exit");
    await eventually(
      () => new ResourceStore(f.directory).read(),
      (state) => state.queue.length === 1,
    );
    const drivers = await Promise.all([active, waiting].map((run) => processIdentity(run.child.pid!)));
    for (const driver of drivers) {
      expect(driver?.pgid).toBe(driver?.pid);
      expect(driver?.pgid).not.toBe(enclosing?.pgid);
    }
    fixtureWork().stop();
    await f.close();
    await Promise.all([active.done, waiting.done]);
    for (const driver of drivers)
      expect((await confirmedIdentity(driver!.pid))?.startTime).not.toBe(driver!.startTime);
    expect(await exists(f.directory)).toBe(false);
    expect(() => f.start("cancelled-no-new-child")).toThrow();
  });
  it("passes bounded tool concurrency through real commands and nested permits", async () => {
    const f = await fixture();
    try {
      for (const [vitest, turbo, expected] of [
        ["", "", ["4", "4"]],
        ["99", "100%", ["4", "4"]],
        ["2", "1", ["2", "1"]],
      ] as const) {
        const receipt = join(f.directory, "parallelism.json");
        const child = f.own(() =>
          spawn(
            process.execPath,
            [
              driver,
              f.directory,
              "parallelism",
              process.execPath,
              driver,
              f.directory,
              "nested-parallelism",
              process.execPath,
              "-e",
              "require('node:fs').writeFileSync(process.argv[1], JSON.stringify([process.env.VITEST_MAX_WORKERS, process.env.TURBO_CONCURRENCY]))",
              receipt,
            ],
            {
              detached: true,
              stdio: "ignore",
              env: { ...process.env, VITEST_MAX_WORKERS: vitest, TURBO_CONCURRENCY: turbo },
            },
          ),
        );
        expect(await new Promise((resolve) => child.once("exit", resolve))).toBe(0);
        expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual(expected);
        expect((await f.governor.snapshot()).capacity.used).toBe(0);
      }
    } finally {
      await f.close();
    }
  }, 30_000);
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
      holder = f.own(() =>
        spawn(resourcePython, ["-I", resourceNativeHelperPath(), "lock", f.directory], {
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        }),
      );
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
      const exits = await Promise.all(queued.map((request) => request.done));
      expect(
        exits,
        queued
          .filter((_, i) => exits[i] !== 0)
          .map((request) => request.output.join(""))
          .join("\n"),
      ).toEqual(Array(11).fill(0));
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
  it("simulator admission uses its own pool and never queues, leaving heavy FIFO order intact", async () => {
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
      // The real heavy runner and its FIFO waiter do not consume simulator capacity.
      const admitted = await f.governor.tryAcquireSimulator(request);
      if (!admitted.admitted) throw new Error("simulator budget unexpectedly blocked by heavy work");
      const blocked = await f.governor.tryAcquireSimulator({ ...request, holderId: "other-child" });
      expect(blocked).toMatchObject({ admitted: false, reason: "simulator_capacity" });
      if (blocked.admitted) throw new Error("unexpected admission");
      expect(blocked.snapshot.leases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "heavy", seatId: "active", pid: expect.any(Number) }),
          expect.objectContaining({ kind: "simulator", seatId: "simulator" }),
        ]),
      );
      expect(blocked.snapshot.capacity).toMatchObject({ used: 1, simulatorUsed: 1 });
      await f.governor.releaseSimulator(admitted.lease.id, admitted.lease.token);
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
      const wrapper = f.own(() =>
        spawn(process.execPath, [registrationDriver, f.directory, mode, claim, ready, submitted], {
          detached: true,
          stdio: "ignore",
        }),
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
          const late = f.own(() =>
            spawn(resourcePython, ["-I", resourceNativeHelperPath(), "run", f.directory, ref.id, ref.token], {
              detached: true,
              stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
            }),
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
      await eventually(() => exists(first.receipt), Boolean).catch((error) => {
        throw new Error(`${String(error)}\nOwned child output:\n${first.output.join("")}`, { cause: error });
      });
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

  it("a different native holder cannot reuse the parent's inherited heavy permit", async () => {
    const f = await fixture();
    try {
      const child = f.start("parent", "nested-other-holder");
      expect(await child.done).toBe(130);
      const waiting = JSON.parse(await readFile(`${child.receipt}.waiting`, "utf8"));
      expect(waiting.capacity.used).toBe(1);
      expect(waiting.queue).toEqual([expect.objectContaining({ holderId: "other-native-child" })]);
      expect((await f.governor.snapshot()).capacity.used).toBe(0);
    } finally {
      await f.close();
    }
  });

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
