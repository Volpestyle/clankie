import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DomainEvent } from "@sapling/protocol";
import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/index.ts";

/**
 * One event per lifecycle type the system emits, exercising every optional
 * envelope field (taskId, workerRunId, causationId) and nested payloads.
 */
const fullEventSet: DomainEvent[] = [
  { type: "mission.created", data: { goal: "Ship the retry module", taskCount: 5 } },
  { type: "mission.started", data: { doctrine: "self-build-lab" } },
  { type: "task.added", data: { title: "Implement retry", kind: "implementation" }, taskId: "t-impl" },
  {
    type: "worker.started",
    data: { workerId: "sim-1", harness: "simulated", taskKind: "implementation", attempt: 1 },
    taskId: "t-impl",
    workerRunId: "run-1",
  },
  { type: "task.started", data: { title: "Implement retry" }, taskId: "t-impl", workerRunId: "run-1" },
  {
    type: "task.failed",
    data: { summary: "Off-by-one detected", diagnosis: "loop bound", evidence: [{ kind: "log" }] },
    taskId: "t-impl",
    workerRunId: "run-1",
    causationId: "e-3",
  },
  { type: "worker.crashed", data: { workerId: "sim-1" }, taskId: "t-impl", workerRunId: "run-1" },
  { type: "task.blocked", data: { reason: "No eligible worker" }, taskId: "t-verify" },
  { type: "task.succeeded", data: { summary: "Repaired", evidenceCount: 2 }, taskId: "t-impl" },
  { type: "worker.completed", data: { workerId: "sim-2", result: "succeeded" }, taskId: "t-impl" },
  {
    type: "approval.recorded",
    data: { actionRequestId: "action-1", decision: "approved", decidedBy: "james" },
  },
  { type: "mission.succeeded", data: { summary: "All acceptance criteria met" } },
].map((partial, index) => ({
  id: `e-${String(index + 1)}`,
  occurredAt: new Date(Date.UTC(2026, 6, 10, 0, 0, index)).toISOString(),
  missionId: index === 7 ? "m-other" : "m-1",
  correlationId: "c-1",
  profileHash: "profile-abc",
  ...partial,
}));

async function temporaryPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "sapling-sqlite-")), "events.db");
}

describe("SqliteEventStore", () => {
  it("round-trips the full event set with ordering and a valid hash chain", async () => {
    const path = await temporaryPath();
    const store = new SqliteEventStore(path);
    for (const event of fullEventSet) await store.append(event);

    const entries = await store.readAll();
    expect(entries.map((entry) => entry.event)).toEqual(fullEventSet);
    expect(entries.map((entry) => entry.sequence)).toEqual(fullEventSet.map((_, index) => index + 1));
    for (let index = 1; index < entries.length; index += 1) {
      expect(entries[index]?.previousHash).toBe(entries[index - 1]?.hash);
    }
    expect(await store.verify()).toEqual({ valid: true, count: fullEventSet.length });
    store.close();

    const reopened = new SqliteEventStore(path);
    expect(await reopened.readAll()).toEqual(entries);
    expect(await reopened.verify()).toEqual({ valid: true, count: fullEventSet.length });
    reopened.close();
  });

  it("treats re-appending an identical event as an idempotent no-op", async () => {
    const store = new SqliteEventStore(await temporaryPath());
    const results = [];
    for (const event of fullEventSet) results.push(await store.append(event));

    const replayed = await store.append(fullEventSet[3] as DomainEvent);
    expect(replayed).toEqual(results[3]);
    expect((await store.readAll()).length).toBe(fullEventSet.length);
    expect(await store.verify()).toMatchObject({ valid: true });
    store.close();
  });

  it("rejects a different event under an existing id", async () => {
    const store = new SqliteEventStore(await temporaryPath());
    const original = fullEventSet[0] as DomainEvent;
    await store.append(original);
    await expect(store.append({ ...original, data: { goal: "tampered" } })).rejects.toThrow(
      /already exists with different content/,
    );
    expect((await store.readAll()).length).toBe(1);
    store.close();
  });

  it("filters by mission id in sequence order", async () => {
    const store = new SqliteEventStore(await temporaryPath());
    for (const event of fullEventSet) await store.append(event);
    const mission = await store.readMission("m-1");
    expect(mission.length).toBe(fullEventSet.length - 1);
    expect(mission.every((entry) => entry.event.missionId === "m-1")).toBe(true);
    expect(await store.readMission("m-other")).toHaveLength(1);
    store.close();
  });

  it("detects tampering with stored rows", async () => {
    const path = await temporaryPath();
    const store = new SqliteEventStore(path);
    for (const event of fullEventSet.slice(0, 3)) await store.append(event);
    store.close();

    const database = new DatabaseSync(path);
    database.exec("UPDATE events SET hash = 'tampered' WHERE sequence = 2");
    database.close();

    const reopened = new SqliteEventStore(path);
    expect(await reopened.verify()).toMatchObject({
      valid: false,
      error: expect.stringContaining("sequence 2") as string,
    });
    reopened.close();
  });

  it("refuses to open a database from a newer schema version", async () => {
    const path = await temporaryPath();
    new SqliteEventStore(path).close();
    const database = new DatabaseSync(path);
    database.exec("PRAGMA user_version = 99");
    database.close();
    expect(() => new SqliteEventStore(path)).toThrow(/newer than this build supports/);
  });
});
