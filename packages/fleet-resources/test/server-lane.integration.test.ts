import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { createResourceGovernor } from "../src/governor.ts";
import { defaultResourcePolicy, type ResourceSnapshot } from "../src/model.ts";
import { heavyJobLane, longHeldJobMs, serverLaneCapacity } from "../src/parallelism.ts";
import { processIdentity, resourceNativeHelperPath, resourcePython } from "../src/process.ts";
import { ResourceStore } from "../src/store.ts";

const serverCommand = join(import.meta.dirname, "fixtures/server-command.mjs");
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  const deadline = Date.now() + 45_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error("Server-lane boundary was not reached");
    await delay(50);
  }
}
const receipt = (path: string) =>
  readFile(path, "utf8").then(
    (text) => JSON.parse(text) as { port: number; vitest: string; turbo: string },
    () => undefined,
  );
const get = async (port: number, path = "/") => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(15_000) });
  return path === "/stop" ? response.text() : response.json();
};

it("servers hold only server slots; bounded builds start, waiters see holders, and aged jobs remain alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-server-lane-"));
  const directory = join(root, "registry");
  // Isolate lane admission from concurrent fleet pressure; the commands,
  // listeners, process groups, runner, journals and CPU supervisor are real.
  const governor = createResourceGovernor({
    directory,
    probe: async () => ({ loadRatio: 0, availableMemoryMb: 64_000 }),
  });
  const jobs: Promise<number>[] = [];
  const stop = new AbortController();
  let legacyHeartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    await writeFile(join(root, "server-command.mjs"), await readFile(serverCommand));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        scripts: { dev: "node server-command.mjs server-0.json" },
      }),
    );
    await governor.configure({ ...defaultResourcePolicy(), heavySlots: 1 });
    // Old arbiters advertise no server lane. A fresh legacy heartbeat must
    // not strand new server waiters until the installed service is refreshed.
    const beat = () =>
      writeFile(join(directory, "arbiter.json"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    await beat();
    legacyHeartbeat = setInterval(() => void beat(), 500);
    const ports: number[] = [];
    for (let index = 0; index < serverLaneCapacity().slots; index++) {
      const path = join(root, `server-${index}.json`);
      jobs.push(
        index === 0
          ? governor.runHeavy("pnpm", ["--dir", root, "dev"], {
              holderId: "owned-server-0",
              seatId: "owned-seat",
            })
          : governor.runHeavy(process.execPath, [serverCommand, path], {
              server: true,
              holderId: `owned-server-${index}`,
              seatId: "owned-seat",
            }),
      );
      const started = (await until(() => receipt(path), Boolean))!;
      ports.push(started.port);
      expect(Number(started.vitest)).toBeLessThanOrEqual(2);
      expect(Number(started.turbo)).toBeLessThanOrEqual(2);
    }
    const snapshots: ResourceSnapshot[] = [];
    clearInterval(legacyHeartbeat);
    legacyHeartbeat = undefined;
    await rm(join(directory, "arbiter.json"), { force: true });
    const queued = governor.runHeavy(process.execPath, [serverCommand, join(root, "queued.json")], {
      server: true,
      holderId: "queued-server",
      signal: stop.signal,
      onWait: (value) => snapshots.push(value),
    });
    jobs.push(queued);
    await until(
      async () => snapshots.length,
      (count) => count > 0,
    );
    expect(snapshots[0]!.capacity).toMatchObject({ used: 0, serverUsed: ports.length });
    expect(snapshots[0]!.serverQueue?.[0]?.holderId).toBe("queued-server");
    expect(snapshots[0]!.holderAlerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lane: "server", reason: "server", holderId: "owned-server-0" }),
      ]),
    );
    // A real bounded command starts and completes while every server slot is
    // still held and another server waits; it cannot be starved by their leases.
    const buildReceipt = join(root, "build.txt");
    expect(
      await governor.runHeavy(process.execPath, [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], 'built')",
        buildReceipt,
      ]),
    ).toBe(0);
    expect(await readFile(buildReceipt, "utf8")).toBe("built");
    for (const port of ports) expect(await get(port)).toHaveProperty("cpuMs");

    // Arrange an old *live* bounded lease using the OS-locked journal; age
    // projection must alert without changing its state or terminating it.
    const held = governor.runHeavy(process.execPath, [serverCommand, join(root, "bounded.json")], {
      holderId: "old-bounded-job",
    });
    jobs.push(held);
    const bounded = (await until(() => receipt(join(root, "bounded.json")), Boolean))!;
    await new ResourceStore(directory).transaction((state) => {
      const lease = state.leases.find(
        (lease) => lease.kind === "heavy" && lease.holderId === "old-bounded-job",
      )!;
      lease.createdAtMs = Date.now() - longHeldJobMs - 1000;
    });
    const status = await governor.snapshot();
    expect(status.holderAlerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lane: "full", reason: "long-held", holderId: "old-bounded-job" }),
      ]),
    );
    expect(await get(bounded.port)).toHaveProperty("cpuMs");
    await get(bounded.port, "/stop");
    expect(await held).toBe(7);
    stop.abort();
    expect(await queued).toBe(130);
    for (const port of ports) await get(port, "/stop");
    expect(await Promise.all(jobs.slice(0, ports.length))).toEqual(ports.map(() => 7));
    expect((await governor.snapshot()).capacity).toMatchObject({ used: 0, serverUsed: 0 });
  } finally {
    if (legacyHeartbeat) clearInterval(legacyHeartbeat);
    stop.abort();
    await governor.close();
    await Promise.allSettled(jobs);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

it.each([true, false])(
  "nested servers reuse server permits and separately govern bounded parents (server parent: %s)",
  async (serverParent) => {
    const root = await mkdtemp(join(tmpdir(), "clankie-nested-servers-"));
    const directory = join(root, "registry");
    const governor = createResourceGovernor({
      directory,
      probe: async () => ({ loadRatio: 0, availableMemoryMb: 64_000 }),
    });
    const stop = new AbortController();
    const jobs: Promise<number>[] = [];
    try {
      await governor.configure({ ...defaultResourcePolicy(), heavySlots: 1 });
      const barrier = join(root, "launch-inner-servers");
      const receipts = Array.from({ length: serverParent ? serverLaneCapacity().slots : 1 }, (_, index) =>
        join(root, `nested-${index}.json`),
      );
      for (const [index, path] of receipts.entries()) {
        jobs.push(
          governor.runHeavy(
            process.execPath,
            [
              join(import.meta.dirname, "fixtures/nested-server.mjs"),
              directory,
              `nested-${index}`,
              barrier,
              path,
              serverCommand,
            ],
            { server: serverParent, holderId: `nested-${index}`, signal: stop.signal },
          ),
        );
        await until(
          async () =>
            readFile(`${path}.ready`)
              .then(() => true)
              .catch(() => false),
          Boolean,
        );
      }
      expect((await governor.snapshot()).capacity).toMatchObject({
        used: serverParent ? 0 : 1,
        serverUsed: serverParent ? receipts.length : 0,
      });
      await writeFile(barrier, "go");
      const ports: number[] = [];
      for (const path of receipts) {
        const started = (await until(
          async () => (await receipt(path)) ?? (await receipt(`${path}.done`)),
          Boolean,
        ))!;
        expect(started.port).toBeTypeOf("number");
        expect(Number(started.turbo)).toBeLessThanOrEqual(2);
        expect((await governor.snapshot()).capacity).toMatchObject({
          used: serverParent ? 0 : 1,
          serverUsed: serverParent ? receipts.length : 1,
        });
        ports.push(started.port);
      }
      for (const port of ports) await get(port, "/stop");
      expect(await Promise.all(jobs)).toEqual(receipts.map(() => 7));
      expect((await governor.snapshot()).capacity).toMatchObject({ used: 0, serverUsed: 0 });
    } finally {
      stop.abort();
      await Promise.allSettled(jobs);
      await governor.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

it.skipIf(process.platform !== "darwin")(
  "a stopped Darwin server launcher can reap an exited child when CPU observation is unavailable",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-zombie-server-"));
    const path = join(root, "zombie.json");
    const governor = createResourceGovernor({
      directory: join(root, "registry"),
      probe: async () => ({ loadRatio: 0, availableMemoryMb: 64_000 }),
    });
    try {
      const code = await governor.runHeavy(
        resourcePython,
        [join(import.meta.dirname, "fixtures/zombie-server.py"), path],
        { server: true, signal: AbortSignal.timeout(12_000) },
      );
      expect(code).toBe(17);
      expect(JSON.parse(await readFile(`${path}.reaped`, "utf8"))).toEqual({ code: 17 });
      expect((await governor.snapshot()).capacity.serverUsed).toBe(0);
    } finally {
      await governor.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);

it.each(process.platform === "darwin" ? [false, true] : [false])(
  "the registered native supervisor bounds CPU and preserves progress with an unreaped grandchild: %s",
  async (zombie) => {
    const root = await mkdtemp(join(tmpdir(), "clankie-server-cpu-"));
    const store = new ResourceStore(root);
    const claimOwner = (await processIdentity())!;
    const id = randomUUID(),
      token = randomUUID();
    await store.transaction((state) =>
      state.leases.push({
        id,
        token,
        kind: "heavy",
        state: "starting",
        claimOwner,
        executable: "node",
        createdAtMs: Date.now(),
        lastUsedAtMs: Date.now(),
      }),
    );
    const runner = spawn(resourcePython, ["-I", resourceNativeHelperPath(), "run", root, id, token], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    });
    let diagnostics = "";
    runner.stderr!.on("data", (data) => (diagnostics += data.toString()));
    const done = new Promise<number>((resolve, reject) => {
      runner.once("error", reject);
      runner.once("exit", (code) => resolve(code ?? -1));
    });
    const replies = createInterface({ input: runner.stdio[4] as Readable });
    try {
      const input = runner.stdio[3] as Writable;
      // Exercise a small fractional budget on every test host. This is the
      // runner's private control pipe, not a worker environment capacity override.
      const args = [serverCommand, join(root, "server.json"), "3"];
      if (zombie) args.push(resourcePython, join(import.meta.dirname, "fixtures/unreaped-child.py"));
      input.write(`${JSON.stringify({ command: process.execPath, args, serverCpuCores: 0.5 })}\n`);
      await replies[Symbol.asyncIterator]().next();
      input.write("go\n");
      const started = (await until(() => receipt(join(root, "server.json")), Boolean))!;
      await until(
        () => get(started.port),
        (sample) => sample.workers === 3,
      );
      let zombiePid: number | undefined;
      if (zombie) {
        await until(() => receipt(join(root, "server.json.zombie")), Boolean);
        const proof = JSON.parse(await readFile(join(root, "server.json.zombie"), "utf8")) as {
          zombie: number;
        };
        zombiePid = proof.zombie;
        // The general lease observer must still report this real libproc failure
        // as unknown. Only the CPU reader's kernel zombie proof skips its CPU.
        await expect(processIdentity(zombiePid)).rejects.toThrow();
      }
      // A signal to the runner alone does not end the owned server. Its CPU
      // governance must remain active while group termination still works.
      process.kill(runner.pid!, "SIGTERM");
      const before = await get(started.port);
      const at = performance.now();
      await delay(6000);
      const after = await get(started.port);
      const elapsedMs = performance.now() - at;
      const cpuCores = (after.cpuMs - before.cpuMs) / elapsedMs;
      if (zombiePid) await expect(processIdentity(zombiePid)).rejects.toThrow();
      if (zombie) {
        expect(diagnostics).not.toContain("CPU enforcement degraded");
        expect(
          await readFile(join(root, "cpu", `${id}.json`), "utf8").catch(() => undefined),
        ).toBeUndefined();
      }
      // The old machine-max uncertainty debt left real transform workers at
      // roughly budget / machine-cores duty cycle while this zombie remained.
      expect(cpuCores).toBeGreaterThan(zombie ? 0.2 : 0);
      // Allow sampling/IPC bursts; an ungoverned three-worker loop exceeds this.
      expect(cpuCores).toBeLessThan(0.85);
      process.stdout.write(
        `Server CPU proof: ${JSON.stringify({ zombie, budgetCores: 0.5, measuredCores: cpuCores, elapsedMs, workers: after.workers })}\n`,
      );
      await get(started.port, "/stop");
      expect(await done).toBe(7);
      expect((await store.read()).leases).toHaveLength(0);
    } finally {
      replies.close();
      if (runner.exitCode === null && runner.pid) {
        process.kill(-runner.pid, "SIGTERM");
        process.kill(-runner.pid, "SIGCONT");
      }
      await done;
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

it("routes dev and watch commands to servers while bounded commands retain their lanes", () => {
  for (const words of [
    ["expo", "start", "--web"],
    ["pnpm", "dev"],
    ["pnpm", "--filter", "@clankie/docs", "dev"],
    ["pnpm", "run", "build:watch"],
    ["pnpm", "exec", "expo", "start", "--dev-client", "--clear"],
    ["npx", "expo", "start"],
    ["vite"],
    ["next", "dev"],
    ["tsx", "watch", "service.ts"],
    ["tsc", "--watch"],
    ["vitest", "a.test.ts"],
    ["node", "--watch", "service.mjs"],
  ])
    expect(heavyJobLane(words[0]!, words.slice(1)), words.join(" ")).toBe("server");
  expect(heavyJobLane("pnpm", ["check:landing"])).toBe("full");
  expect(heavyJobLane("expo", ["export", "--platform", "web"])).toBe("full");
  expect(heavyJobLane("vite", ["build"])).toBe("full");
  expect(heavyJobLane("vitest", ["run", "a.test.ts", "-t", "--watch"])).toBe("light");
  expect(heavyJobLane("tsc", ["--noEmit"])).toBe("light");
  expect(heavyJobLane("sh", ["-c", "pnpm dev"])).toBe("full");
});

it("the lane-aware arbiter holds servers on load and memory, then grants their independent ticket", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-server-arbiter-"));
  let pressure = { loadRatio: 0, availableMemoryMb: 1024 };
  const governor = createResourceGovernor({ directory: root, probe: async () => pressure });
  const controller = new AbortController();
  const path = join(root, "server.json");
  const job = governor.runHeavy(process.execPath, [serverCommand, path], {
    server: true,
    holderId: "arbiter-server",
    signal: controller.signal,
  });
  try {
    await until(
      () => governor.snapshot(),
      (snapshot) => snapshot.serverQueue?.length === 1,
    );
    expect(await governor.arbitrate()).toBe(0);
    pressure = { loadRatio: 10, availableMemoryMb: 64000 };
    expect(await governor.arbitrate()).toBe(0);
    expect(await receipt(path)).toBeUndefined();
    pressure = { loadRatio: 0, availableMemoryMb: 64000 };
    expect(await governor.arbitrate()).toBe(1);
    const started = (await until(() => receipt(path), Boolean))!;
    expect((await governor.snapshot()).capacity).toMatchObject({ used: 0, serverUsed: 1 });
    await get(started.port, "/stop");
    expect(await job).toBe(7);
  } finally {
    controller.abort();
    await governor.close();
    await job;
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
