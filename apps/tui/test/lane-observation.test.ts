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
    entries: [
      { at: "2026-08-09T09:59:00.000Z", kind: "heard", text: "hello" },
      { at: "2026-08-09T10:00:00.000Z", kind: "said", text: "hey" },
    ],
  },
  {
    lane: "discord_voice",
    targetId: "111:333",
    entries: [{ at: "2026-08-09T11:00:00.000Z", kind: "heard", text: "yo" }],
  },
  {
    lane: "operator",
    targetId: "global-default",
    entries: [{ at: "2026-08-09T09:00:00.000Z", kind: "said", text: "ready" }],
  },
  {
    lane: "gameplay",
    targetId: "firered",
    entries: [],
  },
];

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
    expect(listing).toContain("gameplay:firered · quiet");
  });
});

describe("followLane", () => {
  it("reports initial history and only the appended suffix as the bounded window advances", async () => {
    const seen: string[] = [];
    const controller = new AbortController();
    const first = { at: "2026-08-09T10:00:00.000Z", kind: "heard", text: "one" } as const;
    const second = { at: "2026-08-09T10:00:01.000Z", kind: "said", text: "two" } as const;
    const third = { at: "2026-08-09T10:00:02.000Z", kind: "heard", text: "three" } as const;
    const snapshots = [
      [first, second],
      [second, third],
    ];
    let listed = 0;
    await followLane({
      address: { lane: "discord_presence", targetId: "111:222" },
      lanes: {
        lanes: async () => {
          const index = Math.min(listed, snapshots.length - 1);
          listed += 1;
          return [{ ...(lanes[0] as ObservableCaptainLane), entries: snapshots[index]! }];
        },
      },
      signal: controller.signal,
      sleep: async () => {
        if (listed >= 2) controller.abort();
      },
      render: (line) => {
        seen.push(line);
      },
    });
    expect(seen).toEqual([
      "heard · 2026-08-09T10:00:00.000Z\n\none",
      "said · 2026-08-09T10:00:01.000Z\n\ntwo",
      "heard · 2026-08-09T10:00:02.000Z\n\nthree",
    ]);
  });

  it("waits without rendering while a room is quiet", async () => {
    const controller = new AbortController();
    let polls = 0;
    await followLane({
      address: { lane: "gameplay", targetId: "firered" },
      lanes: { lanes: async () => lanes },
      signal: controller.signal,
      sleep: async () => {
        polls += 1;
        if (polls >= 3) controller.abort();
      },
      render: () => {
        throw new Error("a quiet room must not render");
      },
    });
    expect(polls).toBe(3);
  });

  it("backs off while a room stays quiet and snaps back when it changes", async () => {
    // A settled room must not be re-polled at full cadence forever.
    const waits: number[] = [];
    const controller = new AbortController();
    const initial = lanes[0]!.entries;
    const appended = [
      ...initial,
      { at: "2026-08-09T10:01:00.000Z", kind: "heard" as const, text: "anything new?" },
    ];
    let listed = 0;
    await followLane({
      address: { lane: "discord_presence", targetId: "111:222" },
      lanes: {
        lanes: async () => {
          listed += 1;
          return [{ ...(lanes[0] as ObservableCaptainLane), entries: listed < 4 ? initial : appended }];
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
    // Initial history is a change, then two quiet rounds back off, then the
    // appended entry snaps the cadence back.
    expect(waits).toEqual([1_000, 1_000, 2_000, 1_000]);
  });

  it("caps the quiet backoff", async () => {
    const waits: number[] = [];
    const controller = new AbortController();
    let rounds = 0;
    await followLane({
      address: { lane: "gameplay", targetId: "firered" },
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
