import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { createResourceGovernor } from "../src/governor.ts";
import { defaultResourcePolicy, type ResourcePressureInput, type ResourceSnapshot } from "../src/model.ts";
import { heavyJobLane } from "../src/parallelism.ts";

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error("Light-lane boundary was not reached");
    await delay(50);
  }
}

/**
 * Real commands, named the way workers run them. A held command writes its
 * caps, then waits for its release file, so the test controls each slot.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-light-lane-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  const script = `#!${process.execPath}
const { existsSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const out = join(${JSON.stringify(root)}, basename(process.argv[1]) + ".json");
const e = process.env;
writeFileSync(out, JSON.stringify({ vitest: e.VITEST_MAX_WORKERS, cargo: e.CARGO_BUILD_JOBS, make: e.MAKEFLAGS }));
const release = out + ".release";
const wait = () => (existsSync(release) ? process.exit(0) : setTimeout(wait, 50));
wait();
`;
  for (const name of ["vitest", "gate"]) {
    await writeFile(join(bin, name), script);
    await chmod(join(bin, name), 0o755);
  }
  let pressure: ResourcePressureInput = { loadRatio: 0.1, availableMemoryMb: 64_000 };
  const governor = createResourceGovernor({ directory: join(root, "registry"), probe: async () => pressure });
  await governor.configure({ ...defaultResourcePolicy(), heavySlots: 1 });
  const runs: Promise<number>[] = [];
  const run = (
    name: "vitest" | "gate",
    args: string[],
    options: Parameters<typeof governor.runHeavy>[2] = {},
  ) => {
    const job = governor.runHeavy(join(bin, name), args, { holderId: `light-lane-${name}`, ...options });
    runs.push(job.catch(() => -1));
    return job;
  };
  const caps = (name: string) =>
    readFile(join(root, `${name}.json`), "utf8").then(
      (text) => JSON.parse(text) as { vitest: string; cargo: string; make: string },
      () => undefined,
    );
  const release = (name: string) => writeFile(join(root, `${name}.json.release`), "");
  return {
    governor,
    run,
    caps,
    release,
    pressure: (value: ResourcePressureInput) => {
      pressure = value;
    },
    async close() {
      await Promise.all([release("vitest"), release("gate")]);
      // Close first: it cancels a wait that can never be admitted, so a failed
      // step reports its own error instead of hanging here.
      await governor.close();
      await Promise.all(runs);
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("a one-file test starts beside a full gate holding every slot at high load, capped, and shows in status", async () => {
  const f = await fixture();
  try {
    // A full gate takes the only heavy slot.
    const gate = f.run("gate", ["check:landing"]);
    await until(() => f.caps("gate"), Boolean);
    // The machine is now loaded well past the heavy limit.
    f.pressure({ loadRatio: 5, availableMemoryMb: 64_000 });

    // Another full job waits: the full lane keeps its admission.
    const waits: ResourceSnapshot[] = [];
    const stopFull = new AbortController();
    const queuedFull = f.run("gate", ["install"], {
      holderId: "light-lane-queued-full",
      signal: stopFull.signal,
      onWait: (snapshot) => waits.push(snapshot),
    });
    await until(
      async () => waits.length,
      (count) => count > 0,
    );
    expect(waits[0]!.queue).toHaveLength(1);

    // The focused check starts while the gate holds the slot and the full job
    // still waits on load: it never joins their queue. Its wait time is proven
    // live under fleet load, not by a clock here (VUH-1956).
    const focused = f.run("vitest", ["run", "test/fleet-resource-hire.integration.test.ts"]);
    await until(() => f.caps("vitest"), Boolean);
    // Two cores at most; a lower limit the caller already set is kept.
    const caps = (await f.caps("vitest"))!;
    for (const value of [caps.vitest, caps.cargo, /-j(\d+)/u.exec(caps.make)?.[1]])
      expect(Number(value)).toBeLessThanOrEqual(2);

    const status = await f.governor.snapshot();
    expect(status.capacity).toMatchObject({ heavySlots: 1, used: 1, lightSlots: 1, lightUsed: 1 });
    expect(status.lightLeases).toEqual([
      expect.objectContaining({ holderId: "light-lane-vitest", executable: "vitest", state: "running" }),
    ]);
    expect(status.queue.map((entry) => entry.holderId)).toEqual(["light-lane-queued-full"]);

    await f.release("vitest");
    expect(await focused).toBe(0);
    expect((await f.governor.snapshot()).capacity.lightUsed).toBe(0);
    stopFull.abort();
    expect(await queuedFull).toBe(130);
    await f.release("gate");
    expect(await gate).toBe(0);
  } finally {
    await f.close();
  }
}, 120_000);

it("the light lane still holds below the memory floor and lists its waiter", async () => {
  const f = await fixture();
  try {
    f.pressure({ loadRatio: 0.1, availableMemoryMb: 1_024 });
    const stop = new AbortController();
    const focused = f.run("vitest", ["run", "a.test.ts"], { signal: stop.signal });
    const status = await until(
      () => f.governor.snapshot(),
      (snapshot) => snapshot.lightQueue.length === 1,
    );
    expect(status.lightQueue[0]).toMatchObject({ holderId: "light-lane-vitest", executable: "vitest" });
    expect(await f.caps("vitest")).toBeUndefined();
    stop.abort();
    expect(await focused).toBe(130);
  } finally {
    await f.close();
  }
}, 30_000);

it("sizes the commands workers actually run", () => {
  const lanes = Object.fromEntries(
    (
      [
        ["pnpm", "exec", "vitest", "run", "test/fleet-resource-hire.integration.test.ts"],
        [
          "pnpm",
          "exec",
          "vitest",
          "run",
          "packages/fleet-resources/test/heavy-process.integration.test.ts",
          "-t",
          "eleven queued",
        ],
        ["pnpm", "--filter", "@clankie/clankie", "typecheck"],
        ["pnpm", "--workspace-concurrency=1", "--filter", "@clankie/clankie", "typecheck"],
        ["pnpm", "exec", "tsc", "--noEmit", "-p", "tsconfig.json"],
        ["pnpm", "check:landing"],
        ["pnpm", "install", "--frozen-lockfile"],
        ["pnpm", "typecheck"],
        ["pnpm", "--filter", "./packages/*", "typecheck"],
        ["pnpm", "exec", "vitest", "run"],
        ["pnpm", "exec", "vitest", "run", "packages/fleet-resources/test"],
        ["pnpm", "exec", "tsc", "-b"],
        ["xcodebuild", "-scheme", "Clankie", "build"],
        ["sh", "-c", "pnpm exec vitest run a.test.ts"],
      ] as const
    ).map(([command, ...args]) => [[command, ...args].join(" "), heavyJobLane(command, args)]),
  );
  expect(lanes).toEqual({
    "pnpm exec vitest run test/fleet-resource-hire.integration.test.ts": "light",
    "pnpm exec vitest run packages/fleet-resources/test/heavy-process.integration.test.ts -t eleven queued":
      "light",
    "pnpm --filter @clankie/clankie typecheck": "light",
    "pnpm --workspace-concurrency=1 --filter @clankie/clankie typecheck": "light",
    "pnpm exec tsc --noEmit -p tsconfig.json": "light",
    "pnpm check:landing": "full",
    "pnpm install --frozen-lockfile": "full",
    "pnpm typecheck": "full",
    "pnpm --filter ./packages/* typecheck": "full",
    "pnpm exec vitest run": "full",
    "pnpm exec vitest run packages/fleet-resources/test": "full",
    "pnpm exec tsc -b": "full",
    "xcodebuild -scheme Clankie build": "full",
    "sh -c pnpm exec vitest run a.test.ts": "full",
  });
});
