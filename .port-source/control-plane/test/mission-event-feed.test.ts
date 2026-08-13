import { GENESIS_HASH, seal, type StoredEvent } from "@clankie/event-store";
import type { DomainEvent } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { MissionEventFeed } from "../src/mission-event-feed.ts";

const KEY = Uint8Array.from(Buffer.alloc(32, 17));
const BASE_TIME = Date.parse("2026-07-19T20:00:00.000Z");

class CanonicalFixture {
  public readonly entries: StoredEvent[] = [];

  public append(
    type: string,
    data: Record<string, unknown> = {},
    envelope: Partial<DomainEvent> = {},
  ): StoredEvent {
    const sequence = this.entries.length + 1;
    const event: DomainEvent = {
      id: envelope.id ?? `event-${String(sequence)}`,
      occurredAt: envelope.occurredAt ?? new Date(BASE_TIME + sequence * 1_000).toISOString(),
      missionId: envelope.missionId ?? "mission-1",
      correlationId: envelope.correlationId ?? "correlation-1",
      profileHash: envelope.profileHash ?? "profile-1",
      type,
      data,
      ...(envelope.taskId ? { taskId: envelope.taskId } : {}),
      ...(envelope.workerRunId ? { workerRunId: envelope.workerRunId } : {}),
      ...(envelope.causationId ? { causationId: envelope.causationId } : {}),
    };
    const stored = seal(event, sequence, this.entries.at(-1)?.hash ?? GENESIS_HASH);
    this.entries.push(stored);
    return stored;
  }

  public feed(options: { retentionLimit?: number; snapshotLimit?: number } = {}): MissionEventFeed {
    return new MissionEventFeed({
      cursorKey: KEY,
      readCanonicalEvents: () => Promise.resolve(this.entries),
      ...options,
    });
  }
}

function plan(fixture: CanonicalFixture, missionId = "mission-1"): StoredEvent {
  return fixture.append(
    "mission.planned",
    {
      plan: {
        missionId,
        goal: "Exercise the Garden feed",
        rationale: "Fixture",
        tasks: [
          {
            id: "implement",
            title: "Implement",
            objective: "Build",
            kind: "implementation",
            role: "implementer",
            writeScope: ["src/**"],
            successCriteria: ["Done"],
            evidenceRequirements: ["Diff"],
          },
        ],
        successCriteria: ["Done"],
        profileHash: "profile-1",
      },
    },
    { missionId },
  );
}

function started(fixture: CanonicalFixture, missionId = "mission-1"): StoredEvent {
  return fixture.append("mission.execution.started", { captainId: "captain-private" }, { missionId });
}

function worker(
  fixture: CanonicalFixture,
  type: string,
  data: Record<string, unknown>,
  missionId = "mission-1",
): StoredEvent {
  return fixture.append(type, data, {
    missionId,
    taskId: "implement",
    workerRunId: "run-1",
  });
}

describe("MissionEventFeed", () => {
  it("projects a strict bounded safe snapshot while preserving canonical identity and sequence", async () => {
    const canonical = new CanonicalFixture();
    const feed = canonical.feed();
    await feed.publish(plan(canonical));
    await feed.publish(started(canonical));
    await feed.publish(
      worker(canonical, "worker.leased", {
        claimId: "private-claim",
        attempt: 1,
        runnerId: "private-runner",
        leaseExpiresAt: "2026-07-19T20:01:00.000Z",
        worker: {
          id: "codex-1",
          displayName: "Private display name",
          harness: "codex",
          model: "private-provider-model",
          capabilities: {
            kinds: ["implementation"],
            canWrite: true,
            supportsStructuredEvents: true,
            supportsTerminal: true,
            supportsNativeSession: true,
          },
        },
      }),
    );
    await feed.publish(
      worker(canonical, "worker.progress", {
        message: "authorization Bearer secret and a private prompt must never cross",
      }),
    );
    await feed.publish(
      worker(canonical, "worker.settled", {
        result: {
          status: "succeeded",
          summary: "private worker prose",
          evidence: [
            {
              kind: "artifact",
              label: "private artifact label",
              uri: "artifact://runner-evidence/evidence-1",
              summary: "private artifact summary",
            },
            {
              kind: "artifact",
              label: "unsafe reference",
              uri: "https://example.test/secret",
              summary: "must not cross",
            },
          ],
          outputs: { token: "secret" },
        },
      }),
    );

    expect((await feed.selection()).activeMission).toMatchObject({
      missionId: "mission-1",
      generation: "event-2",
    });
    const snapshot = await feed.snapshot("mission-1");
    expect(snapshot.outcome).toBe("snapshot");
    if (snapshot.outcome !== "snapshot") throw new Error("expected snapshot");
    expect(snapshot.events.map((event) => [event.sourceSequence, event.type])).toEqual([
      [2, "mission.execution.started"],
      [3, "worker.leased"],
      [4, "worker.progress"],
      [5, "worker.settled"],
    ]);
    expect(snapshot.events[1]).toMatchObject({
      eventId: "event-3",
      previousSourceSequence: 2,
      taskId: "implement",
      workerRunId: "run-1",
      data: { workerId: "codex-1", harness: "codex", taskKind: "implementation", attempt: 1 },
    });
    expect(snapshot.events[3]).toMatchObject({
      type: "worker.settled",
      data: { result: "succeeded", artifactIds: ["artifact://runner-evidence/evidence-1"] },
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toMatch(/secret|private|prompt|claimId|runnerId|displayName|model|token/iu);
  });

  it("replays retained events once, rejects invalid cursors, and expires pruned cursors explicitly", async () => {
    const canonical = new CanonicalFixture();
    const feed = canonical.feed({ retentionLimit: 3, snapshotLimit: 3 });
    await feed.publish(plan(canonical));
    await feed.publish(started(canonical));
    const initial = await feed.snapshot("mission-1");
    if (initial.outcome !== "snapshot") throw new Error("expected snapshot");
    await feed.publish(
      worker(canonical, "worker.started", {
        workerId: "codex-1",
        harness: "codex",
        taskKind: "implementation",
        attempt: 1,
      }),
    );
    await feed.publish(worker(canonical, "worker.turn.started", { private: "ignored" }));

    const abort = new AbortController();
    const opened = await feed.openTail("mission-1", initial.nextCursor, abort.signal);
    expect(opened.outcome).toBe("tail");
    if (opened.outcome !== "tail") throw new Error("expected tail");
    const iterator = opened.stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "mission_event.event", event: { sourceSequence: 3 } },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "mission_event.event", event: { sourceSequence: 4, previousSourceSequence: 3 } },
    });
    abort.abort();
    await iterator.return?.();

    await expect(
      feed.openTail("mission-1", "tampered.cursor", new AbortController().signal),
    ).resolves.toMatchObject({ outcome: "cursor_invalid" });

    await feed.publish(worker(canonical, "worker.progress", { message: "ignored" }));
    await feed.publish(worker(canonical, "worker.waiting_user", { questionSummary: "private" }));
    await expect(
      feed.openTail("mission-1", initial.nextCursor, new AbortController().signal),
    ).resolves.toMatchObject({ outcome: "cursor_expired", replayAfterSourceSequenceFloor: 3 });
  });

  it("makes mission replacement explicit and rejects non-idempotent ordering", async () => {
    const canonical = new CanonicalFixture();
    const feed = canonical.feed();
    await feed.publish(plan(canonical));
    await feed.publish(started(canonical));
    const snapshot = await feed.snapshot("mission-1");
    if (snapshot.outcome !== "snapshot") throw new Error("expected snapshot");
    const replacementPlan = plan(canonical, "mission-2");
    const replacementStart = started(canonical, "mission-2");
    await feed.publish(replacementPlan);
    await feed.publish(replacementStart);

    await expect(
      feed.openTail("mission-1", snapshot.nextCursor, new AbortController().signal),
    ).resolves.toMatchObject({
      outcome: "mission_replaced",
      requestedMissionId: "mission-1",
      replacementMission: { missionId: "mission-2", generation: "event-4" },
    });
    await feed.publish(replacementStart);
    const conflictingPast = seal(
      { ...replacementPlan.event, id: "late-event", missionId: "mission-3" },
      replacementPlan.sequence,
      replacementPlan.previousHash,
    );
    await expect(feed.publish(conflictingPast)).rejects.toThrow("already reconciled canonical log");
    const rebound = seal(
      { ...replacementStart.event, missionId: "mission-3" },
      replacementStart.sequence + 1,
      replacementStart.hash,
    );
    await expect(feed.publish(rebound)).rejects.toThrow("rebound");
  });

  it("reconciles concurrently completed event-store appends by canonical sequence", async () => {
    const canonical = new CanonicalFixture();
    const feed = canonical.feed();
    const planned = plan(canonical);
    const executionStarted = started(canonical);
    await feed.publish(executionStarted);
    expect((await feed.selection()).activeMission).toMatchObject({ generation: "event-2" });
    await feed.publish(planned);

    const snapshot = await feed.snapshot("mission-1");
    expect(snapshot.outcome).toBe("snapshot");
    if (snapshot.outcome !== "snapshot") throw new Error("expected snapshot");
    expect(snapshot.events.map((event) => event.sourceSequence)).toEqual([2]);
    expect((await feed.selection()).activeMission).toMatchObject({ generation: "event-2" });
  });

  it("fails explicitly when the canonical authority is missing, corrupt, unreadable, or regressed", async () => {
    const canonical = new CanonicalFixture();
    const planned = plan(canonical);
    const executionStarted = started(canonical);

    const missing = new MissionEventFeed({
      cursorKey: KEY,
      readCanonicalEvents: () => Promise.resolve([executionStarted]),
    });
    await expect(missing.selection()).rejects.toThrow("Hash-chain mismatch at sequence 1");

    const corrupt = new MissionEventFeed({
      cursorKey: KEY,
      readCanonicalEvents: () => Promise.resolve([{ ...planned, hash: "corrupt" }]),
    });
    await expect(corrupt.selection()).rejects.toThrow("Hash-chain mismatch at sequence 1");

    const unreadable = new MissionEventFeed({
      cursorKey: KEY,
      readCanonicalEvents: () => Promise.reject(new Error("database unreadable")),
    });
    await expect(unreadable.selection()).rejects.toThrow("authority could not be read");

    const regressed = new MissionEventFeed({
      cursorKey: KEY,
      initialEvents: canonical.entries,
      readCanonicalEvents: () => Promise.resolve([planned]),
    });
    await expect(regressed.selection()).rejects.toThrow("authority regressed from sequence 2 to 1");
  });
});
