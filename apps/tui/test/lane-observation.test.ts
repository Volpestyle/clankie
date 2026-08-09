import type { Client, HandleMessageStreamEvent, SessionState } from "eve/client";
import type { ObservableCaptainLane } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import {
  createCaptainLaneClient,
  followLane,
  formatLaneListing,
  laneKey,
  selectLanes,
} from "../src/session/lane-observation.ts";

const lanes: readonly ObservableCaptainLane[] = [
  {
    lane: "discord_presence",
    targetId: "111:222",
    sessionId: "session-a",
    state: "completed",
    updatedAt: "2026-08-09T10:00:00.000Z",
  },
  {
    lane: "discord_voice",
    targetId: "111:333",
    sessionId: "session-b",
    state: "active",
    updatedAt: "2026-08-09T11:00:00.000Z",
  },
  {
    lane: "tui",
    targetId: "operator",
    sessionId: "session-c",
    state: "waiting",
    updatedAt: "2026-08-09T09:00:00.000Z",
  },
  {
    lane: "gameplay",
    targetId: "firered",
    state: "completed",
    updatedAt: "2026-08-09T08:00:00.000Z",
  },
];

function fakeClient(input: {
  readonly streams: readonly (readonly HandleMessageStreamEvent[])[];
  readonly onStream?: (state: SessionState, startIndex: number | undefined) => void;
}): Client {
  let call = 0;
  return {
    session: (state: SessionState = { streamIndex: 0 }) => ({
      stream: (options?: { signal?: AbortSignal; startIndex?: number }) => {
        input.onStream?.(state, options?.startIndex);
        const events = input.streams[call] ?? [];
        call += 1;
        return (async function* () {
          for (const event of events) yield event;
        })();
      },
    }),
  } as unknown as Client;
}

const boundary = {
  type: "session.completed",
  data: { sessionId: "session-a" },
} as unknown as HandleMessageStreamEvent;

describe("captain lane listing client", () => {
  it("parses the authenticated listing", async () => {
    const client = createCaptainLaneClient({
      fetch: async (path) => {
        expect(path).toBe("/captain/v1/lanes");
        return new Response(JSON.stringify({ schemaVersion: 1, lanes: [lanes[0]] }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    await expect(client.lanes()).resolves.toEqual([lanes[0]]);
  });

  it("rejects a listing that fails the public schema", async () => {
    const client = createCaptainLaneClient({
      fetch: async () =>
        new Response(JSON.stringify({ schemaVersion: 1, lanes: [{ lane: "nope", targetId: "x" }] })),
    });
    await expect(client.lanes()).rejects.toThrow(/schema validation/u);
  });

  it("surfaces an unauthorized listing as an error rather than an empty room list", async () => {
    const client = createCaptainLaneClient({ fetch: async () => new Response("", { status: 401 }) });
    await expect(client.lanes()).rejects.toThrow(/401/u);
  });
});

describe("lane selection", () => {
  it("treats a bare /trace as every room except the operator's own", () => {
    expect(selectLanes(lanes, "").map(laneKey)).toEqual([
      "discord_presence:111:222",
      "discord_voice:111:333",
      "gameplay:firered",
    ]);
    expect(selectLanes(lanes, "all").map(laneKey)).toHaveLength(3);
  });

  it("selects a whole lane by name", () => {
    expect(selectLanes(lanes, "discord_presence").map(laneKey)).toEqual(["discord_presence:111:222"]);
  });

  it("selects one room by target id or key", () => {
    expect(selectLanes(lanes, "111:333").map(laneKey)).toEqual(["discord_voice:111:333"]);
    expect(selectLanes(lanes, "discord_voice:111:333").map(laneKey)).toEqual(["discord_voice:111:333"]);
  });

  it("falls back to a substring so a guild id alone finds its rooms", () => {
    expect(selectLanes(lanes, "111").map(laneKey)).toEqual([
      "discord_presence:111:222",
      "discord_voice:111:333",
    ]);
  });

  it("marks the rooms already being watched, newest first", () => {
    const listing = formatLaneListing(lanes, new Set(["discord_voice:111:333"]));
    const rows = listing.split("\n");
    expect(rows[0]).toContain("▶ discord_voice:111:333");
    expect(rows[1]).toContain("  discord_presence:111:222");
    expect(listing).toContain("gameplay:firered · no session yet");
  });
});

describe("followLane", () => {
  it("renders a room's stream and resumes from the index it reached", async () => {
    const seen: string[] = [];
    const streamed: { sessionId: string | undefined; startIndex: number | undefined }[] = [];
    const controller = new AbortController();
    const client = fakeClient({
      streams: [[boundary, boundary], [boundary]],
      onStream: (state, startIndex) => {
        streamed.push({ sessionId: state.sessionId, startIndex });
      },
    });
    let rounds = 0;
    await followLane({
      address: { lane: "discord_presence", targetId: "111:222" },
      client,
      lanes: { lanes: async () => lanes },
      signal: controller.signal,
      sleep: async () => {
        rounds += 1;
        if (rounds >= 2) controller.abort();
      },
      render: (event) => {
        seen.push(event.type);
      },
    });
    expect(seen).toEqual(["session.completed", "session.completed", "session.completed"]);
    expect(streamed).toEqual([
      { sessionId: "session-a", startIndex: 0 },
      { sessionId: "session-a", startIndex: 2 },
    ]);
  });

  it("restarts at index 0 and resets the renderer when the room's session rotates", async () => {
    // A Discord text lane gets a fresh Eve session per turn: the tail must not
    // resume the new session at the old session's index.
    const streamed: { sessionId: string | undefined; startIndex: number | undefined }[] = [];
    const rotations: string[] = [];
    const controller = new AbortController();
    const sessions = ["turn-one", "turn-two"];
    let listed = 0;
    const client = fakeClient({
      streams: [[boundary], [boundary]],
      onStream: (state, startIndex) => {
        streamed.push({ sessionId: state.sessionId, startIndex });
      },
    });
    await followLane({
      address: { lane: "discord_presence", targetId: "111:222" },
      client,
      lanes: {
        lanes: async () => {
          const sessionId = sessions[Math.min(listed, sessions.length - 1)] as string;
          listed += 1;
          return [{ ...(lanes[0] as ObservableCaptainLane), sessionId }];
        },
      },
      signal: controller.signal,
      sleep: async () => {
        if (listed >= 2) controller.abort();
      },
      render: () => undefined,
      onSessionRotated: (sessionId) => {
        rotations.push(sessionId);
      },
    });
    expect(rotations).toEqual(["turn-one", "turn-two"]);
    expect(streamed).toEqual([
      { sessionId: "turn-one", startIndex: 0 },
      { sessionId: "turn-two", startIndex: 0 },
    ]);
  });

  it("waits without rendering while a room has no session yet", async () => {
    const controller = new AbortController();
    let polls = 0;
    const client = fakeClient({ streams: [[boundary]] });
    await followLane({
      address: { lane: "gameplay", targetId: "firered" },
      client,
      lanes: { lanes: async () => lanes },
      signal: controller.signal,
      sleep: async () => {
        polls += 1;
        if (polls >= 3) controller.abort();
      },
      render: () => {
        throw new Error("a room with no session must not render");
      },
    });
    expect(polls).toBe(3);
  });

  it("backs off while a room stays quiet and snaps back when it speaks", async () => {
    // A settled room must not be re-opened every two seconds forever.
    const waits: number[] = [];
    const controller = new AbortController();
    let listed = 0;
    await followLane({
      address: { lane: "discord_presence", targetId: "111:222" },
      client: fakeClient({ streams: [[], [], [boundary], []] }),
      lanes: {
        lanes: async () => {
          listed += 1;
          return lanes;
        },
      },
      signal: controller.signal,
      pollIntervalMs: 1_000,
      sleep: async (ms) => {
        waits.push(ms);
        if (listed >= 4) controller.abort();
      },
      render: () => undefined,
    });
    expect(waits).toEqual([1_000, 2_000, 1_000, 1_000]);
  });

  it("caps the quiet backoff", async () => {
    const waits: number[] = [];
    const controller = new AbortController();
    let rounds = 0;
    await followLane({
      address: { lane: "discord_presence", targetId: "111:222" },
      client: fakeClient({ streams: [] }),
      lanes: { lanes: async () => lanes },
      signal: controller.signal,
      pollIntervalMs: 4_000,
      sleep: async (ms) => {
        waits.push(ms);
        rounds += 1;
        if (rounds >= 4) controller.abort();
      },
      render: () => undefined,
    });
    expect(waits).toEqual([4_000, 8_000, 15_000, 15_000]);
  });

  it("keeps following after a listing failure and reports it once", async () => {
    const notices: string[] = [];
    const controller = new AbortController();
    let calls = 0;
    await followLane({
      address: { lane: "discord_presence", targetId: "111:222" },
      client: fakeClient({ streams: [[boundary]] }),
      lanes: {
        lanes: async () => {
          calls += 1;
          if (calls === 1) throw new Error("captain unreachable");
          return lanes;
        },
      },
      signal: controller.signal,
      sleep: async () => {
        if (calls >= 2) controller.abort();
      },
      render: () => undefined,
      onNotice: (message) => {
        notices.push(message);
      },
    });
    expect(notices).toEqual(["captain unreachable"]);
  });

  it("does not repeat the same failure every round while the captain stays down", async () => {
    const notices: string[] = [];
    const controller = new AbortController();
    let calls = 0;
    await followLane({
      address: { lane: "discord_presence", targetId: "111:222" },
      client: fakeClient({ streams: [] }),
      lanes: {
        lanes: async () => {
          calls += 1;
          throw new Error("captain unreachable");
        },
      },
      signal: controller.signal,
      sleep: async () => {
        if (calls >= 4) controller.abort();
      },
      render: () => undefined,
      onNotice: (message) => {
        notices.push(message);
      },
    });
    expect(calls).toBe(4);
    expect(notices).toEqual(["captain unreachable"]);
  });
});
