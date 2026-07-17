import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  SqliteMissionEventSource,
  type MissionEventBatch,
  type MissionEventSource,
  type ObservedMissionEvent,
  type SequencedMissionEvent,
} from "../src/observation/mission-events.ts";
import { MissionObserver } from "../src/observation/mission-observer.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryPath(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mission-observer-"));
  tempDirs.push(root);
  return join(root, name);
}

function event(
  sequence: number,
  type: string,
  options: {
    missionId?: string;
    taskId?: string;
    workerRunId?: string;
    data?: Record<string, unknown>;
  } = {},
): SequencedMissionEvent {
  const missionId = options.missionId ?? "mission-1";
  const observed: ObservedMissionEvent = {
    id: `event-${sequence.toString()}`,
    occurredAt: new Date(sequence * 1_000).toISOString(),
    missionId,
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    ...(options.workerRunId === undefined ? {} : { workerRunId: options.workerRunId }),
    correlationId: missionId,
    profileHash: "profile-1",
    type,
    data: options.data ?? {},
  };
  return { sequence, event: observed };
}

class FakeEventSource implements MissionEventSource {
  public readonly identity = "fake:mission-events";
  public readonly requested: number[] = [];
  public readonly events: SequencedMissionEvent[];

  public constructor(events: SequencedMissionEvent[]) {
    this.events = events;
  }

  public readAfter(sequence: number): Promise<MissionEventBatch> {
    this.requested.push(sequence);
    return Promise.resolve({
      throughSequence: this.events.at(-1)?.sequence ?? 0,
      events: this.events.filter((entry) => entry.sequence > sequence),
    });
  }
}

function initialEvents(): SequencedMissionEvent[] {
  return [
    event(1, "mission.drafted", { data: { goal: "Observe the mission" } }),
    event(2, "mission.planned", {
      data: {
        plan: {
          goal: "Observe the mission",
          tasks: [
            {
              id: "implement",
              title: "Implement",
              dependsOn: [],
            },
            {
              id: "verify",
              title: "Verify",
              dependsOn: ["implement"],
            },
          ],
        },
      },
    }),
    event(3, "mission.execution.started"),
    event(4, "worker.leased", {
      taskId: "implement",
      workerRunId: "run-1",
      data: { worker: { harness: "codex" } },
    }),
    event(5, "task.started", { taskId: "implement", workerRunId: "run-1" }),
  ];
}

function captainEvent(
  sequence: number,
  type:
    | "captain.presence.online"
    | "captain.presence.offline"
    | "captain.heartbeat"
    | "captain.turn.started"
    | "captain.turn.settled"
    | "captain.waiting_dependency",
  state: "working" | "waiting_user" | "waiting_dependency" | "idle" | "offline",
  options: { generationId?: string; summary?: string } = {},
): SequencedMissionEvent {
  const generationId = options.generationId ?? "generation-1";
  const observedAt = new Date(sequence * 1_000).toISOString();
  const lease = {
    schemaVersion: 1,
    subjectId: "captain",
    captainId: "captain-1",
    leaseId: `lease-${generationId}`,
    generationId,
  };
  const tierOne = {
    ...lease,
    heartbeatAt: observedAt,
    expiresAt: new Date((sequence + 60) * 1_000).toISOString(),
    state,
    tier: 1,
    source: "control-plane.captain_lease",
    confidence: 1,
    observedAt,
    ...(type === "captain.presence.offline" ? { reason: "lease_expired" } : {}),
  };
  const tierZero = {
    ...lease,
    sessionId: "session-1",
    turnId: `turn-${sequence.toString()}`,
    state,
    tier: 0,
    source: "eve.lifecycle",
    confidence: 1,
    observedAt,
    ...(state === "waiting_user" ? { questionSummary: options.summary ?? "Choose a release target" } : {}),
    ...(state === "waiting_dependency" ? { summary: options.summary ?? "Waiting for verifier" } : {}),
  };
  return event(sequence, type, {
    missionId: "captain-presence",
    data:
      type === "captain.presence.online" ||
      type === "captain.presence.offline" ||
      type === "captain.heartbeat"
        ? tierOne
        : tierZero,
  });
}

describe("MissionObserver", () => {
  it("projects missions, task dependencies, workers, and a sequenced event tail", async () => {
    const source = new FakeEventSource(initialEvents());
    const checkpointPath = await temporaryPath("state/observer.json");
    const observer = new MissionObserver({ source, checkpointPath });

    await observer.restore();
    await expect(observer.refresh()).resolves.toBe(true);

    expect(observer.dashboard).toMatchObject({
      connection: "live at sequence 5",
      cursor: 5,
      mission: "mission-1 · Observe the mission",
      missions: [{ id: "mission-1", state: "running", selected: true }],
      tasks: [
        { id: "implement", state: "running", dependsOn: [] },
        { id: "verify", state: "queued", dependsOn: ["implement"] },
      ],
      agents: [{ id: "run-1", harness: "codex", state: "working", task: "implement" }],
    });
    expect(observer.dashboard.timeline.at(-1)).toBe("#5 task.started · implement · run-1");
    expect((await stat(checkpointPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(checkpointPath, ".."))).mode & 0o777).toBe(0o700);
  });

  it("displays Discord presence phase from its semantic event without terminal output", async () => {
    const source = new FakeEventSource([
      event(1, "discord.presence.session.phase_changed", {
        missionId: "discord-presence:discord:bot:fixture",
        data: {
          previousPhase: "present",
          phase: "degraded",
          reason: "gateway_disconnected",
          session: { sessionId: "discord:bot:fixture" },
        },
      }),
    ]);
    const observer = new MissionObserver({
      source,
      checkpointPath: await temporaryPath("presence-observer.json"),
    });
    await observer.refresh();
    expect(observer.dashboard).toMatchObject({
      mission: "discord-presence:discord:bot:fixture · Discord presence · discord:bot:fixture",
      missions: [{ id: "discord-presence:discord:bot:fixture", state: "degraded", selected: true }],
      timeline: ["#1 discord presence present → degraded · gateway_disconnected"],
    });
  });

  it("projects every captain state live from the authoritative semantic event stream", async () => {
    const source = new FakeEventSource([]);
    const observer = new MissionObserver({
      source,
      checkpointPath: await temporaryPath("captain-observer.json"),
    });
    const transitions = [
      captainEvent(1, "captain.presence.online", "idle"),
      captainEvent(2, "captain.turn.started", "working"),
      captainEvent(3, "captain.turn.settled", "waiting_user"),
      captainEvent(4, "captain.waiting_dependency", "waiting_dependency"),
      captainEvent(5, "captain.turn.settled", "idle"),
      captainEvent(6, "captain.presence.offline", "offline"),
    ] as const;

    for (const transition of transitions) {
      source.events.push(transition);
      await expect(observer.refresh()).resolves.toBe(true);
      expect(observer.captainPresence?.state).toBe(transition.event.data.state);
    }
  });

  it("preserves tier-zero and offline precedence across checkpoint restore", async () => {
    const source = new FakeEventSource([
      captainEvent(1, "captain.presence.online", "idle"),
      captainEvent(2, "captain.turn.settled", "waiting_user"),
    ]);
    const checkpointPath = await temporaryPath("state/captain-observer.json");
    const first = new MissionObserver({ source, checkpointPath });
    await first.refresh();
    expect(first.captainPresence?.state).toBe("waiting_user");

    source.events.push(captainEvent(3, "captain.heartbeat", "idle"));
    const restored = new MissionObserver({ source, checkpointPath });
    await restored.restore();
    await restored.refresh();
    expect(restored.captainPresence?.state).toBe("waiting_user");

    source.events.push(captainEvent(4, "captain.presence.online", "idle", { generationId: "generation-2" }));
    await restored.refresh();
    expect(restored.captainPresence?.state).toBe("idle");

    source.events.push(
      captainEvent(5, "captain.presence.offline", "offline", { generationId: "generation-2" }),
    );
    await restored.refresh();
    const offlineRestored = new MissionObserver({ source, checkpointPath });
    await offlineRestored.restore();
    source.events.push(captainEvent(6, "captain.heartbeat", "idle", { generationId: "generation-2" }));
    await offlineRestored.refresh();
    expect(offlineRestored.captainPresence?.state).toBe("offline");
  });

  it("restarts from the durable cursor and applies each missed event once", async () => {
    const source = new FakeEventSource(initialEvents());
    const checkpointPath = await temporaryPath("state/observer.json");
    const first = new MissionObserver({ source, checkpointPath });
    await first.restore();
    await first.refresh();

    source.events.push(
      event(6, "worker.waiting_user", {
        taskId: "implement",
        workerRunId: "run-1",
      }),
    );
    const restarted = new MissionObserver({ source, checkpointPath });
    await restarted.restore();
    expect(restarted.dashboard.cursor).toBe(5);
    await restarted.refresh();

    expect(source.requested.at(-1)).toBe(5);
    expect(restarted.dashboard.cursor).toBe(6);
    expect(restarted.dashboard.agents[0]?.state).toBe("waiting");
    expect(restarted.dashboard.timeline.filter((line) => line.startsWith("#6 "))).toHaveLength(1);
    expect(JSON.parse(await readFile(checkpointPath, "utf8"))).toMatchObject({ lastSequence: 6 });
  });

  it("supports only mission selection and next/previous navigation", async () => {
    const source = new FakeEventSource([
      event(1, "mission.drafted", { missionId: "mission-1", data: { goal: "First" } }),
      event(2, "mission.drafted", { missionId: "mission-2", data: { goal: "Second" } }),
    ]);
    const observer = new MissionObserver({
      source,
      checkpointPath: await temporaryPath("observer.json"),
    });
    await observer.restore();
    await observer.refresh();

    expect(observer.dashboard.mission).toContain("mission-2");
    await expect(observer.selectMission("prev")).resolves.toBe(true);
    expect(observer.dashboard.mission).toContain("mission-1");
    await expect(observer.selectMission("mission-2")).resolves.toBe(true);
    expect(observer.dashboard.mission).toContain("mission-2");
    await expect(observer.selectMission("missing")).resolves.toBe(false);
  });

  it("rejects a sequence gap instead of presenting partial mission state", async () => {
    const observer = new MissionObserver({
      source: new FakeEventSource([
        event(1, "mission.drafted", { data: { goal: "Gap" } }),
        event(3, "mission.started"),
      ]),
      checkpointPath: await temporaryPath("observer.json"),
    });
    await expect(observer.refresh()).rejects.toThrow("sequence gap");
    expect(observer.dashboard.cursor).toBe(0);
  });

  it("discards a malformed checkpoint and rebuilds from sequence zero", async () => {
    const checkpointPath = await temporaryPath("observer.json");
    await writeFile(
      checkpointPath,
      `${JSON.stringify({
        version: 1,
        sourceId: "fake:mission-events",
        lastSequence: 5,
        missions: [null],
      })}\n`,
      "utf8",
    );
    const source = new FakeEventSource(initialEvents());
    const observer = new MissionObserver({ source, checkpointPath });

    await observer.restore();
    expect(observer.dashboard.cursor).toBe(0);
    expect(observer.dashboard.attention[0]).toContain("saved observation state was invalid");
    await observer.refresh();
    expect(source.requested).toEqual([0]);
    expect(observer.dashboard.cursor).toBe(5);
  });

  it("strips terminal control characters from event-controlled labels", async () => {
    const observer = new MissionObserver({
      source: new FakeEventSource([
        event(1, "mission.drafted", { data: { goal: "safe\u001B]52;c;payload\u0007 goal" } }),
      ]),
      checkpointPath: await temporaryPath("observer.json"),
    });
    await observer.refresh();
    expect(observer.dashboard.mission).toBe("mission-1 · safe]52;c;payload goal");
    expect(
      Array.from(observer.dashboard.mission).every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code > 31 && !(code >= 127 && code <= 159);
      }),
    ).toBe(true);
  });
});

describe("SqliteMissionEventSource", () => {
  it("reads only the ordered suffix from the durable event log", async () => {
    const path = await temporaryPath("events.db");
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE events (sequence INTEGER PRIMARY KEY, event TEXT NOT NULL)");
    for (const entry of initialEvents().slice(0, 3)) {
      database
        .prepare("INSERT INTO events (sequence, event) VALUES (?, ?)")
        .run(entry.sequence, JSON.stringify(entry.event));
    }
    database.close();

    const before = await stat(path);
    const source = new SqliteMissionEventSource(path);
    await expect(source.readAfter(1)).resolves.toMatchObject({
      throughSequence: 3,
      events: [{ sequence: 2 }, { sequence: 3 }],
    });
    const after = await stat(path);
    expect({ mtimeMs: after.mtimeMs, size: after.size }).toEqual({
      mtimeMs: before.mtimeMs,
      size: before.size,
    });
  });

  it("does not create a missing database from the observation path", async () => {
    const path = await temporaryPath("missing/events.db");
    await expect(new SqliteMissionEventSource(path).readAfter(0)).rejects.toThrow();
  });
});
