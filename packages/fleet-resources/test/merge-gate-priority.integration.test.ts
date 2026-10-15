import { randomUUID } from "node:crypto";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { createResourceGovernor } from "../src/governor.ts";
import { defaultResourcePolicy } from "../src/model.ts";
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const value = await read();
    if (accepts(value)) return value;
    await delay(50);
  }
  throw new Error("Admission did not reach the required state");
}
const hold = `const fs = require('node:fs'); fs.writeFileSync(process.argv[1], '');
const timer = setInterval(() => { if (fs.existsSync(process.argv[2])) { clearInterval(timer); } }, 20);`;

it.each(["arbiter", "fallback"] as const)(
  "%s admits gates in full FIFO order and shares spare slots with builds and light work",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "clankie-gate-priority-"));
    // This data/API boundary controls pressure, not the processes, native runners,
    // process births, OS locks or journals. A zero settle interval lets small CI
    // hosts exercise both slots without pretending these marker commands ramp up.
    // The surrounding check has a real permit.
    const directory = join(root, "registry");
    const probe = async () => ({ loadRatio: 0, cpuRatio: 0, availableMemoryMb: 65_536 });
    const client = createResourceGovernor({ directory, probe, heavyJobSettleMs: 0 });
    const service = createResourceGovernor({ directory, probe, heavyJobSettleMs: 0 });
    const policy = { ...defaultResourcePolicy(), heavySlots: 2 };
    const stop = new AbortController();
    const runs: Promise<number>[] = [];
    const releases: string[] = [];
    let timer: ReturnType<typeof setInterval> | undefined;
    let pass: Promise<number> | undefined;
    const start = (name: string, mergeGate?: string, command = process.execPath, args?: string[]) => {
      const marker = join(root, `${name}.started`),
        release = join(root, `${name}.release`);
      releases.push(release);
      const run = client.runHeavy(command, args ?? ["-e", hold, marker, release], {
        signal: stop.signal,
        holderId: name,
        ...(mergeGate ? { mergeGate } : {}),
      });
      runs.push(run);
      return { marker, release, run };
    };
    try {
      await client.configure(policy);
      const existing = await client.tryAcquireSimulator({
        seatId: "old-seat",
        occupantId: "old-owner",
        externalActive: async () => 0,
      });
      expect(existing.admitted).toBe(true);
      if (!existing.admitted) throw new Error("Expected existing reservation");
      await client.configure({ ...policy, minAvailableMemoryMb: 1_048_576 });
      const normal = start("normal");
      await until(
        () => client.snapshot(),
        (s) => s.queue.length === 1,
      );
      const firstId = randomUUID(),
        secondId = randomUUID();
      const first = start("gate-first", firstId);
      await until(
        () => client.snapshot(),
        (s) => s.queue.length === 2,
      );
      const later = start("normal-later");
      await until(
        () => client.snapshot(),
        (s) => s.queue.length === 3,
      );
      const second = start("gate-second", secondId);
      await until(
        () => client.snapshot(),
        (s) => s.queue.length === 4,
      );
      const compiler = join(root, "tsc");
      const lightMarker = join(root, "light.started"),
        lightRelease = join(root, "light.release");
      await writeFile(
        compiler,
        `#!${process.execPath}\n${hold.replace("process.argv[1]", JSON.stringify(lightMarker)).replace("process.argv[2]", JSON.stringify(lightRelease))}\n`,
      );
      await chmod(compiler, 0o700);
      const light = start("light", undefined, compiler, ["--noEmit"]);
      await until(
        () => client.snapshot(),
        (s) => s.lightQueue.length === 1,
      );
      await client.updateSimulator(existing.lease.id, existing.lease.token, { phase: "boot-submitted" });
      const blocked = await client.tryAcquireSimulator({
        seatId: "new-seat",
        occupantId: "new-owner",
        externalActive: async () => 0,
      });
      expect(blocked).toMatchObject({ admitted: false, reason: "simulator_capacity" });
      if (mode === "arbiter") {
        await service.arbitrate();
        timer = setInterval(() => {
          pass ??= service.arbitrate().finally(() => {
            pass = undefined;
          });
        }, 50);
      }
      await client.configure(policy);
      await until(() => exists(normal.marker), Boolean);
      await until(() => exists(first.marker), Boolean);
      await until(() => exists(light.marker), Boolean);
      expect(await exists(later.marker)).toBe(false);
      expect(await exists(second.marker)).toBe(false);
      expect((await client.snapshot()).mergeGate).toMatchObject({ batchId: firstId, state: "running" });
      await writeFile(normal.release, "");
      expect(await normal.run).toBe(0);
      // A build queued after the first gate starts while it is still running;
      // a later gate cannot jump that build or reserve the remaining slot.
      await until(() => exists(later.marker), Boolean);
      expect(await exists(second.marker)).toBe(false);
      expect((await client.snapshot()).capacity.used).toBe(2);
      await writeFile(later.release, "");
      expect(await later.run).toBe(0);
      await until(() => exists(second.marker), Boolean);
      await writeFile(first.release, "");
      expect(await first.run).toBe(0);
      await writeFile(second.release, "");
      expect(await second.run).toBe(0);
      expect((await client.snapshot()).mergeGate).toBeUndefined();
      expect((await client.snapshot()).leases.some((row) => row.id === existing.lease.id)).toBe(true);
      await client.updateSimulator(existing.lease.id, existing.lease.token, { phase: "boot-submitted" });
      await client.releaseSimulator(existing.lease.id, existing.lease.token);
      const admitted = await client.tryAcquireSimulator({
        seatId: "new-seat",
        occupantId: "new-owner",
        externalActive: async () => 0,
      });
      expect(admitted.admitted).toBe(true);
      if (admitted.admitted) await client.releaseSimulator(admitted.lease.id, admitted.lease.token);
    } finally {
      if (timer) clearInterval(timer);
      await pass;
      stop.abort();
      await Promise.all(releases.map((file) => writeFile(file, "")));
      await client.close();
      await service.close();
      await Promise.allSettled(runs);
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("cancelling a queued gate removes its ticket without opening the memory floor", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-cancel-gate-"));
  const governor = createResourceGovernor({
    directory: root,
    probe: async () => ({ loadRatio: 0, availableMemoryMb: 2048 }),
  });
  const stop = new AbortController();
  let run: Promise<number> | undefined;
  try {
    await governor.configure({ ...defaultResourcePolicy(), heavySlots: 1 });
    run = governor.runHeavy(process.execPath, ["-e", "throw new Error('must not start')"], {
      mergeGate: randomUUID(),
      signal: stop.signal,
    });
    await until(
      () => governor.snapshot(),
      (state) => Boolean(state.mergeGate),
    );
    stop.abort();
    expect(await run).toBe(130);
    const status = await governor.snapshot();
    expect(status.mergeGate).toBeUndefined();
    expect(status.queue).toHaveLength(0);
    expect(status.capacity.used).toBe(0);
    expect(status.pressure.reason).toBe("memory");
  } finally {
    stop.abort();
    await run;
    await governor.close();
    await rm(root, { recursive: true, force: true });
  }
});
