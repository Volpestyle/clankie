import { spawn } from "node:child_process";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@clankie/event-store";
import { describe, expect, it } from "vitest";
import { ProcessLeaseManager } from "../src/process-leases.ts";

const holder = {
  missionId: "m-1",
  taskId: "t-1",
  workerRunId: "run-1",
  profileHash: "profile-abc",
};

async function makeManager(
  overrides: Partial<ConstructorParameters<typeof ProcessLeaseManager>[0]> = {},
): Promise<{
  manager: ProcessLeaseManager;
  events: SqliteEventStore;
  rootDir: string;
  now: { value: Date };
}> {
  const rootDir = overrides.rootDir ?? (await mkdtemp(join(tmpdir(), "clankie-please-")));
  const events = (overrides.events as SqliteEventStore) ?? new SqliteEventStore(":memory:");
  const now = { value: new Date("2026-07-10T00:00:00.000Z") };
  const manager = new ProcessLeaseManager({
    rootDir,
    events,
    clock: () => now.value,
    processIdentity: (pid) => Promise.resolve(`identity-${String(pid)}`),
    killProcess: () => undefined,
    ...overrides,
  });
  return { manager, events, rootDir, now };
}

async function eventTypes(events: SqliteEventStore): Promise<string[]> {
  return (await events.readAll()).map((entry) => entry.event.type);
}

describe("ProcessLeaseManager", () => {
  it("transitions an expired heartbeat to a recoverable state with event evidence", async () => {
    const { manager, events, now } = await makeManager({ leaseDurationMs: 10_000 });
    const lease = await manager.register({ ...holder, pid: 111 });

    now.value = new Date("2026-07-10T00:00:05.000Z");
    await manager.heartbeat(lease.id);
    now.value = new Date("2026-07-10T00:00:12.000Z");
    expect(await manager.expireStale()).toEqual([]); // heartbeat extended the window

    now.value = new Date("2026-07-10T00:00:20.000Z");
    const expired = await manager.expireStale();
    expect(expired.map((entry) => entry.id)).toEqual([lease.id]);
    expect(expired[0]?.state).toBe("expired");

    await expect(manager.heartbeat(lease.id)).rejects.toThrow(/expired; heartbeat refused/);
    expect(await eventTypes(events)).toEqual(["worker.lease.registered", "worker.lease.expired"]);
    const record = (await events.readAll()).at(-1)?.event;
    expect(record).toMatchObject({ missionId: "m-1", taskId: "t-1", workerRunId: "run-1" });
  });

  it("refuses to lease a dead process", async () => {
    const { manager } = await makeManager({ processIdentity: () => Promise.resolve(undefined) });
    await expect(manager.register({ ...holder, pid: 999 })).rejects.toThrow(/not alive/);
  });

  it("cancels cooperatively via SIGTERM when the worker exits in the grace window", async () => {
    const child = spawn(process.execPath, [
      "-e",
      'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000); console.log("ready");',
    ]);
    await new Promise((resolvePromise) => child.stdout.once("data", resolvePromise));
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) =>
      child.on("exit", (code, signal) => resolvePromise({ code, signal })),
    );

    const rootDir = await mkdtemp(join(tmpdir(), "clankie-please-"));
    const events = new SqliteEventStore(":memory:");
    const manager = new ProcessLeaseManager({ rootDir, events, cancelGraceMs: 5_000 });
    const lease = await manager.register({ ...holder, pid: child.pid as number });

    const cancelled = await manager.cancel(lease.id, "operator requested stop");
    expect(cancelled.state).toBe("cancelled");
    // Cooperative: the child exited itself on SIGTERM, no SIGKILL needed.
    await expect(exit).resolves.toEqual({ code: 0, signal: null });
    expect(await eventTypes(events)).toEqual([
      "worker.lease.registered",
      "worker.cancel.requested",
      "worker.cancelled",
    ]);
  }, 15_000);

  it("escalates to SIGKILL when the worker ignores SIGTERM, idempotently", async () => {
    const child = spawn(process.execPath, [
      "-e",
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log("ready");',
    ]);
    await new Promise((resolvePromise) => child.stdout.once("data", resolvePromise));
    const exit = new Promise<{ signal: NodeJS.Signals | null }>((resolvePromise) =>
      child.on("exit", (_code, signal) => resolvePromise({ signal })),
    );

    const rootDir = await mkdtemp(join(tmpdir(), "clankie-please-"));
    const events = new SqliteEventStore(":memory:");
    const manager = new ProcessLeaseManager({ rootDir, events, cancelGraceMs: 750 });
    const lease = await manager.register({ ...holder, pid: child.pid as number });

    const first = await manager.cancel(lease.id, "stuck worker");
    expect(first.state).toBe("cancelled");
    await expect(exit).resolves.toEqual({ signal: "SIGKILL" });

    // Idempotent: a second cancel returns state without new events or signals.
    const second = await manager.cancel(lease.id, "stuck worker again");
    expect(second.state).toBe("cancelled");
    expect(await eventTypes(events)).toEqual([
      "worker.lease.registered",
      "worker.cancel.requested",
      "worker.cancelled",
    ]);
  }, 15_000);

  it("re-adopts live processes and fails dead or recycled pids explicitly on restart", async () => {
    // All three processes are alive at registration time.
    const identities = new Map<number, string | undefined>([
      [111, "identity-111"],
      [222, "identity-222"],
      [333, "identity-333"],
    ]);
    const base = {
      processIdentity: (pid: number) => Promise.resolve(identities.get(pid)),
      leaseDurationMs: 60_000,
    };
    const { manager, events, rootDir } = await makeManager({ ...base, runnerPid: 1001 });
    const live = await manager.register({ ...holder, pid: 111 });
    const dead = await manager.register({ ...holder, workerRunId: "run-2", pid: 222, taskId: "t-2" });
    const recycled = await manager.register({
      ...holder,
      workerRunId: "run-3",
      pid: 333,
      taskId: "t-3",
    });
    // The runner "crashes"; while it is down, 222 dies and 333 is recycled.
    identities.set(222, undefined);
    identities.set(333, "identity-333-recycled");

    const restarted = new ProcessLeaseManager({
      rootDir,
      events,
      runnerPid: 1002,
      processIdentity: base.processIdentity,
      killProcess: () => undefined,
    });
    const report = await restarted.reconcile();
    expect(report.readopted.map((entry) => entry.id)).toEqual([live.id]);
    expect(report.failed.map((entry) => entry.id).sort()).toEqual([dead.id, recycled.id].sort());
    expect(report.retained).toEqual([]);

    // Second reconcile: pure no-op — no duplicate adoption or loss events.
    const again = await restarted.reconcile();
    expect(again.readopted).toEqual([]);
    expect(again.failed).toEqual([]);
    expect(again.retained.map((entry) => entry.id)).toEqual([live.id]);
    const types = await eventTypes(events);
    expect(types.filter((type) => type === "worker.readopted")).toHaveLength(1);
    expect(types.filter((type) => type === "worker.lost")).toHaveLength(2);
  });

  it("resumes a cancellation the previous runner died in the middle of", async () => {
    const identities = new Map<number, string | undefined>([[111, "identity-111"]]);
    const kills: NodeJS.Signals[] = [];
    const { manager, events, rootDir } = await makeManager({
      runnerPid: 1001,
      processIdentity: (pid) => Promise.resolve(identities.get(pid)),
      cancelGraceMs: 100,
    });
    const lease = await manager.register({ ...holder, pid: 111 });
    // Simulate a runner that crashed after persisting "cancelling".
    const file = join(rootDir, "process-leases", `${lease.id}.json`);
    await writeFile(file, JSON.stringify({ ...lease, state: "cancelling" }), "utf8");

    const restarted = new ProcessLeaseManager({
      rootDir,
      events,
      runnerPid: 1002,
      cancelGraceMs: 100,
      processIdentity: (pid) => Promise.resolve(identities.get(pid)),
      killProcess: (_pid, signal) => {
        kills.push(signal);
        if (signal === "SIGTERM") identities.set(111, undefined); // cooperative exit
      },
    });
    const report = await restarted.reconcile();
    expect(report.resumedCancels.map((entry) => entry.state)).toEqual(["cancelled"]);
    expect(kills).toEqual(["SIGTERM"]);
    expect(await eventTypes(events)).toContain("worker.cancelled");

    // No absorbing state: a later cancel is a clean no-op.
    const again = await restarted.cancel(lease.id, "again");
    expect(again.state).toBe("cancelled");
    const types = await eventTypes(events);
    expect(types.filter((type) => type === "worker.cancelled")).toHaveLength(1);
  });

  it("does not starve heartbeats while a cancellation waits out its grace period", async () => {
    const identities = new Map<number, string | undefined>([
      [111, "identity-111"],
      [222, "identity-222"],
    ]);
    const { manager } = await makeManager({
      processIdentity: (pid) => Promise.resolve(identities.get(pid)),
      cancelGraceMs: 1_000,
      killProcess: () => undefined, // the worker ignores every signal
    });
    const healthy = await manager.register({ ...holder, pid: 111 });
    const stuck = await manager.register({ ...holder, workerRunId: "run-2", taskId: "t-2", pid: 222 });

    const cancelling = manager.cancel(stuck.id, "stuck");
    const winner = await Promise.race([
      manager.heartbeat(healthy.id).then(() => "heartbeat"),
      cancelling.then(() => "cancel"),
    ]);
    expect(winner).toBe("heartbeat");
    expect((await cancelling).state).toBe("cancelled");
  }, 10_000);

  it("collapses concurrent cancels into one event pair", async () => {
    const identities = new Map<number, string | undefined>([[111, "identity-111"]]);
    const kills: NodeJS.Signals[] = [];
    const { manager, events } = await makeManager({
      processIdentity: (pid) => Promise.resolve(identities.get(pid)),
      cancelGraceMs: 100,
      killProcess: (_pid, signal) => {
        kills.push(signal);
        identities.set(111, undefined);
      },
    });
    const lease = await manager.register({ ...holder, pid: 111 });
    const [first, second] = await Promise.all([
      manager.cancel(lease.id, "first"),
      manager.cancel(lease.id, "second"),
    ]);
    expect(first.state).toBe("cancelled");
    expect(second.state).toBe("cancelled");
    expect(kills).toEqual(["SIGTERM"]);
    expect(await eventTypes(events)).toEqual([
      "worker.lease.registered",
      "worker.cancel.requested",
      "worker.cancelled",
    ]);
  });

  it("supersedes a cancel whose worker completed normally during the grace window", async () => {
    const identities = new Map<number, string | undefined>([[111, "identity-111"]]);
    const { manager, events } = await makeManager({
      processIdentity: (pid) => Promise.resolve(identities.get(pid)),
      cancelGraceMs: 300,
      killProcess: () => undefined, // ignores SIGTERM; completes on its own instead
    });
    const lease = await manager.register({ ...holder, pid: 111 });
    const cancelling = manager.cancel(lease.id, "operator stop");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    await manager.complete(lease.id);

    const outcome = await cancelling;
    expect(outcome.state).toBe("completed");
    const types = await eventTypes(events);
    expect(types).toContain("worker.cancel.superseded");
    expect(types).not.toContain("worker.cancelled");
  });

  it("removes corrupt lease files during reconciliation", async () => {
    const { manager, rootDir, events } = await makeManager();
    await manager.register({ ...holder, pid: 111 });
    const dir = join(rootDir, "process-leases");
    await writeFile(join(dir, "broken.json"), "{not json", "utf8");

    const restarted = new ProcessLeaseManager({
      rootDir,
      events,
      runnerPid: 1002,
      processIdentity: () => Promise.resolve("identity-111"),
      killProcess: () => undefined,
    });
    const report = await restarted.reconcile();
    expect(report.corruptRemoved).toEqual([join(dir, "broken.json")]);
    expect((await readdir(dir)).filter((file) => file === "broken.json")).toEqual([]);
    // Never a silent loss: the removal itself is evidenced in the event log.
    expect(await eventTypes(events)).toContain("worker.lease.corrupt");
  });

  it("retires completed leases without recovery semantics", async () => {
    const { manager } = await makeManager();
    const lease = await manager.register({ ...holder, pid: 111 });
    await manager.complete(lease.id);
    expect(await manager.list()).toEqual([]);
    await expect(manager.heartbeat(lease.id)).rejects.toThrow(/Unknown process lease/);
  });
});
