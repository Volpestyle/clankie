import type { StoredEvent } from "@clankie/event-store";
import type { DomainEvent } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { MissionEventFeed } from "../src/mission-event-feed.ts";

const KEY = Uint8Array.from(Buffer.alloc(32, 17));
const BASE_TIME = Date.parse("2026-07-19T20:00:00.000Z");

function stored(
  sequence: number,
  type: string,
  data: Record<string, unknown> = {},
  envelope: Partial<DomainEvent> = {},
): StoredEvent {
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
  return { sequence, previousHash: `hash-${String(sequence - 1)}`, hash: `hash-${String(sequence)}`, event };
}

function plan(sequence = 1, missionId = "mission-1"): StoredEvent {
  return stored(
    sequence,
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

function started(sequence = 2, missionId = "mission-1"): StoredEvent {
  return stored(sequence, "mission.execution.started", { captainId: "captain-private" }, { missionId });
}

function worker(
  sequence: number,
  type: string,
  data: Record<string, unknown>,
  missionId = "mission-1",
): StoredEvent {
  return stored(sequence, type, data, {
    missionId,
    taskId: "implement",
    workerRunId: "run-1",
  });
}

describe("MissionEventFeed", () => {
  it("projects a strict bounded safe snapshot while preserving canonical identity and sequence", () => {
    const feed = new MissionEventFeed({ cursorKey: KEY });
    feed.publish(plan());
    feed.publish(started());
    feed.publish(
      worker(3, "worker.leased", {
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
    feed.publish(
      worker(4, "worker.progress", {
        message: "authorization Bearer secret and a private prompt must never cross",
      }),
    );
    feed.publish(
      worker(5, "worker.settled", {
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

    expect(feed.selection().activeMission).toMatchObject({ missionId: "mission-1", generation: "event-2" });
    const snapshot = feed.snapshot("mission-1");
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
    const feed = new MissionEventFeed({ cursorKey: KEY, retentionLimit: 3, snapshotLimit: 3 });
    feed.publish(plan());
    feed.publish(started());
    const initial = feed.snapshot("mission-1");
    if (initial.outcome !== "snapshot") throw new Error("expected snapshot");
    feed.publish(
      worker(3, "worker.started", {
        workerId: "codex-1",
        harness: "codex",
        taskKind: "implementation",
        attempt: 1,
      }),
    );
    feed.publish(worker(4, "worker.turn.started", { private: "ignored" }));

    const abort = new AbortController();
    const opened = feed.openTail("mission-1", initial.nextCursor, abort.signal);
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

    expect(feed.openTail("mission-1", "tampered.cursor", new AbortController().signal)).toMatchObject({
      outcome: "cursor_invalid",
    });

    feed.publish(worker(5, "worker.progress", { message: "ignored" }));
    feed.publish(worker(6, "worker.waiting_user", { questionSummary: "private" }));
    expect(feed.openTail("mission-1", initial.nextCursor, new AbortController().signal)).toMatchObject({
      outcome: "cursor_expired",
      replayAfterSourceSequenceFloor: 3,
    });
  });

  it("makes mission replacement explicit and rejects non-idempotent ordering", () => {
    const feed = new MissionEventFeed({ cursorKey: KEY });
    feed.publish(plan());
    feed.publish(started());
    const snapshot = feed.snapshot("mission-1");
    if (snapshot.outcome !== "snapshot") throw new Error("expected snapshot");
    feed.publish(plan(3, "mission-2"));
    feed.publish(started(4, "mission-2"));

    expect(feed.openTail("mission-1", snapshot.nextCursor, new AbortController().signal)).toMatchObject({
      outcome: "mission_replaced",
      requestedMissionId: "mission-1",
      replacementMission: { missionId: "mission-2", generation: "event-4" },
    });
    feed.publish(started(4, "mission-2"));
    expect(() =>
      feed.publish(stored(3, "mission.execution.started", {}, { id: "late-event", missionId: "mission-3" })),
    ).toThrow("canonical event-store order");
    expect(() =>
      feed.publish(stored(5, "mission.execution.started", {}, { id: "event-4", missionId: "mission-3" })),
    ).toThrow("rebound");
  });

  it("serializes concurrently completed event-store appends by canonical sequence", () => {
    const feed = new MissionEventFeed({ cursorKey: KEY });
    feed.publish(started(2));
    expect(feed.selection().activeMission).toBeNull();
    feed.publish(plan());

    const snapshot = feed.snapshot("mission-1");
    expect(snapshot.outcome).toBe("snapshot");
    if (snapshot.outcome !== "snapshot") throw new Error("expected snapshot");
    expect(snapshot.events.map((event) => event.sourceSequence)).toEqual([2]);
    expect(feed.selection().activeMission).toMatchObject({ generation: "event-2" });
  });
});
