import { MissionEventFeedClientError, ClankieApiClient, type MissionEventObservation } from "../src/index.ts";
import { describe, expect, it, vi } from "vitest";

const mission = {
  schemaVersion: 1 as const,
  missionId: "mission-1",
  generation: "start-1",
  startedAt: "2026-07-19T20:00:00.000Z",
  profileHash: "profile-1",
};

function event(sourceSequence: number, previousSourceSequence: number, eventId = `event-${sourceSequence}`) {
  return {
    schemaVersion: 1 as const,
    eventId,
    sourceSequence,
    previousSourceSequence,
    occurredAt: new Date(Date.parse(mission.startedAt) + sourceSequence * 1_000).toISOString(),
    missionId: mission.missionId,
    correlationId: "correlation-1",
    profileHash: mission.profileHash,
    type: "mission.execution.started" as const,
    data: {},
  };
}

function snapshot() {
  return {
    schemaVersion: 1 as const,
    outcome: "snapshot" as const,
    mission,
    replayAfterSourceSequenceFloor: 0,
    resumeAfterSourceSequence: 2,
    nextCursor: "cursor-2",
    compacted: false,
    omittedEventCount: 0,
    events: [event(2, 0, "start-1")],
  };
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe("ClankieApiClient mission event feed", () => {
  it("uses the paired-device credential for active discovery and strict snapshots", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer device-session" });
      if (String(input).endsWith("/v1/missions/active")) {
        return Response.json({ schemaVersion: 1, activeMission: mission });
      }
      return Response.json(snapshot());
    });
    const client = new ClankieApiClient({
      baseUrl: "http://127.0.0.1:4310",
      fetchImpl,
      deviceToken: "device-session",
    });

    await expect(client.discoverActiveMission()).resolves.toEqual({
      schemaVersion: 1,
      activeMission: mission,
    });
    await expect(client.getMissionEventSnapshot("mission-1")).resolves.toMatchObject({
      outcome: "snapshot",
      resumeAfterSourceSequence: 2,
    });
  });

  it("deduplicates reconnect replay, advances opaque cursors, and surfaces replacement", async () => {
    let tailCalls = 0;
    const third = { ...event(3, 2), taskId: undefined };
    const fourth = event(4, 3);
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (!url.includes("/tail")) return Response.json(snapshot());
      tailCalls += 1;
      if (tailCalls === 1) {
        expect(url).toContain("cursor=cursor-2");
        const delivery = {
          schemaVersion: 1,
          type: "mission_event.event",
          event: third,
          cursor: "cursor-3",
        };
        return new Response(line(delivery) + line(delivery), {
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      expect(url).toContain("cursor=cursor-3");
      return new Response(
        line({
          schemaVersion: 1,
          type: "mission_event.event",
          event: fourth,
          cursor: "cursor-4",
        }) +
          line({
            schemaVersion: 1,
            type: "mission_event.recovery",
            recovery: {
              schemaVersion: 1,
              outcome: "mission_replaced",
              requestedMissionId: "mission-1",
              replacementMission: { ...mission, missionId: "mission-2", generation: "start-2" },
            },
          }),
        { headers: { "content-type": "application/x-ndjson" } },
      );
    });
    const client = new ClankieApiClient({
      baseUrl: "http://127.0.0.1:4310",
      fetchImpl,
      deviceToken: "device-session",
    });
    const observed: MissionEventObservation[] = [];
    for await (const item of client.observeMissionEvents("mission-1", { reconnectDelayMs: 0 })) {
      observed.push(item);
    }

    expect(observed.map((item) => item.type)).toEqual(["snapshot", "event", "event", "recovery"]);
    expect(observed.filter((item) => item.type === "event").map((item) => item.event.sourceSequence)).toEqual(
      [3, 4],
    );
    expect(observed[2]).toMatchObject({
      type: "event",
      resume: { cursor: "cursor-4", afterSourceSequence: 4, lastEventId: "event-4" },
    });
    expect(tailCalls).toBe(2);
  });

  it.each([
    ["duplicate_conflict", event(2, 0, "conflicting-start")],
    ["out_of_order", event(1, 0)],
    ["sequence_gap", event(4, 1)],
  ] as const)("fails closed on %s delivery", async (code, hostile) => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (!String(input).includes("/tail")) return Response.json(snapshot());
      return new Response(
        line({
          schemaVersion: 1,
          type: "mission_event.event",
          event: hostile,
          cursor: "hostile-cursor",
        }),
      );
    });
    const client = new ClankieApiClient({
      baseUrl: "http://127.0.0.1:4310",
      fetchImpl,
      deviceToken: "device-session",
    });
    const iterator = client
      .observeMissionEvents("mission-1", { reconnectDelayMs: 0 })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "snapshot" } });
    await expect(iterator.next()).rejects.toMatchObject({
      name: "MissionEventFeedClientError",
      code,
    } satisfies Partial<MissionEventFeedClientError>);
  });

  it("fails before I/O without a device credential and types authorization failure", async () => {
    const noTokenFetch = vi.fn<typeof fetch>();
    const noToken = new ClankieApiClient({
      baseUrl: "http://127.0.0.1:4310",
      fetchImpl: noTokenFetch,
    });
    await expect(noToken.discoverActiveMission()).rejects.toThrow("paired device session token");
    expect(noTokenFetch).not.toHaveBeenCalled();

    const denied = new ClankieApiClient({
      baseUrl: "http://127.0.0.1:4310",
      deviceToken: "expired",
      fetchImpl: vi.fn(async () =>
        Response.json(
          { schemaVersion: 1, outcome: "auth_failed", reason: "session_expired" },
          { status: 401 },
        ),
      ),
    });
    await expect(denied.discoverActiveMission()).rejects.toMatchObject({
      name: "MissionEventFeedClientError",
      code: "authentication_failed",
    });
  });

  it("ends cleanly when an in-flight tail request is cancelled", async () => {
    const abort = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (!String(input).includes("/tail")) return Response.json(snapshot());
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), {
          once: true,
        });
      });
    });
    const client = new ClankieApiClient({
      baseUrl: "http://127.0.0.1:4310",
      fetchImpl,
      deviceToken: "device-session",
    });
    const iterator = client
      .observeMissionEvents("mission-1", { signal: abort.signal })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "snapshot" } });
    const pending = iterator.next();
    abort.abort();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });
});
