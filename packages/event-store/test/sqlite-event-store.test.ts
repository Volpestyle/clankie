import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { DomainEvent } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { OptimisticConcurrencyError, SqliteEventStore } from "../src/index.ts";

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
  return join(await mkdtemp(join(tmpdir(), "clankie-sqlite-")), "events.db");
}

interface ConcurrentAppendResult {
  ok: boolean;
  error?: { name: string; message: string; code?: string; optimistic: boolean };
}

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const concurrentWriter = fileURLToPath(new URL("./fixtures/append-expected-writer.ts", import.meta.url));

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

function startConcurrentWriter(
  databasePath: string,
  readyPath: string,
  releasePath: string,
  event: DomainEvent,
): Promise<ConcurrentAppendResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      resolve(repoRoot, "node_modules/.bin/tsx"),
      [
        concurrentWriter,
        databasePath,
        readyPath,
        releasePath,
        Buffer.from(JSON.stringify(event), "utf8").toString("base64url"),
      ],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Concurrent writer exited ${String(code)}: ${stderr}\n${stdout}`));
        return;
      }
      const line = stdout.trim().split("\n").at(-1);
      if (!line) {
        reject(new Error(`Concurrent writer returned no result: ${stderr}`));
        return;
      }
      resolvePromise(JSON.parse(line) as ConcurrentAppendResult);
    });
  });
}

async function raceExpectedAppends(
  databasePath: string,
  left: DomainEvent,
  right: DomainEvent,
): Promise<[ConcurrentAppendResult, ConcurrentAppendResult]> {
  const nonce = crypto.randomUUID();
  const readyLeft = join(tmpdir(), `event-ready-left-${nonce}`);
  const readyRight = join(tmpdir(), `event-ready-right-${nonce}`);
  const release = join(tmpdir(), `event-release-${nonce}`);
  const leftResult = startConcurrentWriter(databasePath, readyLeft, release, left);
  const rightResult = startConcurrentWriter(databasePath, readyRight, release, right);
  await Promise.all([waitForFile(readyLeft), waitForFile(readyRight)]);
  await writeFile(release, "go\n", "utf8");
  try {
    return await Promise.all([leftResult, rightResult]);
  } finally {
    await Promise.all([
      rm(readyLeft, { force: true }),
      rm(readyRight, { force: true }),
      rm(release, { force: true }),
    ]);
  }
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

  it("atomically compares a projection stream revision without breaking idempotent replay", async () => {
    const store = new SqliteEventStore(await temporaryPath());
    const first = {
      ...(fullEventSet[0] as DomainEvent),
      id: "projection-1",
      missionId: "character:clankie",
    };
    const second = {
      ...(fullEventSet[1] as DomainEvent),
      id: "projection-2",
      missionId: "character:clankie",
    };

    const appended = await store.appendExpected(first, {
      streamId: "character:clankie",
      expectedRevision: 0,
    });
    expect(
      await store.appendExpected(first, {
        streamId: "character:clankie",
        expectedRevision: 0,
      }),
    ).toEqual(appended);
    const staleWrite = await store
      .appendExpected(second, {
        streamId: "character:clankie",
        expectedRevision: 0,
      })
      .catch((error: unknown) => error);
    expect(staleWrite).toBeInstanceOf(OptimisticConcurrencyError);
    expect(staleWrite).toMatchObject({
      name: "OptimisticConcurrencyError",
      streamId: "character:clankie",
      expectedRevision: 0,
      actualRevision: 1,
    });
    await store.appendExpected(second, {
      streamId: "character:clankie",
      expectedRevision: 1,
    });
    expect((await store.readStream("character:clankie")).map((entry) => entry.event.id)).toEqual([
      "projection-1",
      "projection-2",
    ]);
    store.close();
  });

  it("normalizes real multi-process write contention to optimistic concurrency", async () => {
    for (let iteration = 0; iteration < 16; iteration += 1) {
      const path = await temporaryPath();
      if (iteration % 2 === 0) new SqliteEventStore(path).close();
      const streamId = `character:race-${String(iteration)}`;
      const left = {
        ...(fullEventSet[0] as DomainEvent),
        id: `race-left-${String(iteration)}`,
        missionId: streamId,
      };
      const right = {
        ...(fullEventSet[1] as DomainEvent),
        id: `race-right-${String(iteration)}`,
        missionId: streamId,
      };

      const outcomes = await raceExpectedAppends(path, left, right);
      expect(
        outcomes.filter((outcome) => outcome.ok),
        `iteration ${String(iteration)}`,
      ).toHaveLength(1);
      const loser = outcomes.find((outcome) => !outcome.ok);
      expect(loser?.error, `iteration ${String(iteration)}`).toMatchObject({
        name: "OptimisticConcurrencyError",
        optimistic: true,
      });
      expect(loser?.error?.message).not.toMatch(/database is (?:busy|locked)/iu);

      const store = new SqliteEventStore(path);
      expect(await store.readStream(streamId)).toHaveLength(1);
      expect(await store.verify()).toEqual({ valid: true, count: 1 });
      store.close();
    }
  }, 30_000);

  it("does not leak raw SQLite lock errors across the appendExpected boundary", async () => {
    const path = await temporaryPath();
    new SqliteEventStore(path).close();

    const blocker = new DatabaseSync(path);
    blocker.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE");
    const nonce = crypto.randomUUID();
    const ready = join(tmpdir(), `event-ready-blocked-${nonce}`);
    const release = join(tmpdir(), `event-release-blocked-${nonce}`);
    await writeFile(release, "go\n", "utf8");
    const resultPromise = startConcurrentWriter(path, ready, release, {
      ...(fullEventSet[0] as DomainEvent),
      id: `blocked-${nonce}`,
    });
    const unlock = setTimeout(() => {
      blocker.exec("COMMIT");
      blocker.close();
    }, 100);

    try {
      const result = await resultPromise;
      expect(result.error?.message ?? "").not.toMatch(/database is (?:busy|locked)/iu);
      if (!result.ok) expect(result.error?.optimistic).toBe(true);
    } finally {
      clearTimeout(unlock);
      if (blocker.isOpen) {
        blocker.exec("ROLLBACK");
        blocker.close();
      }
      await Promise.all([rm(ready, { force: true }), rm(release, { force: true })]);
    }
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
