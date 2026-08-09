import { describe, expect, it } from "vitest";
import { CAPTAIN_LANE_LISTING_MAX } from "@clankie/protocol";
import type { CaptainLaneSnapshot } from "@clankie/captain-runtime";
import { renderCaptainLaneListing } from "../agent/channels/captain-lanes.ts";

function snapshot(overrides: Partial<CaptainLaneSnapshot> = {}): CaptainLaneSnapshot {
  return {
    key: "lane-key",
    characterId: "clankie",
    lane: "discord_presence",
    targetId: "111:222",
    sessionId: "session-a",
    state: "completed",
    revision: 3,
    createdAt: "2026-08-09T09:00:00.000Z",
    updatedAt: "2026-08-09T10:00:00.000Z",
    ...overrides,
  };
}

describe("captain lane listing", () => {
  it("publishes the room, its durable session, and its state, newest first", () => {
    const listing = renderCaptainLaneListing([
      snapshot(),
      snapshot({
        key: "b",
        lane: "discord_voice",
        targetId: "111:333",
        sessionId: "session-b",
        state: "active",
        updatedAt: "2026-08-09T11:00:00.000Z",
      }),
    ]);
    expect(listing).toEqual({
      schemaVersion: 1,
      lanes: [
        {
          lane: "discord_voice",
          targetId: "111:333",
          sessionId: "session-b",
          state: "active",
          updatedAt: "2026-08-09T11:00:00.000Z",
        },
        {
          lane: "discord_presence",
          targetId: "111:222",
          sessionId: "session-a",
          state: "completed",
          updatedAt: "2026-08-09T10:00:00.000Z",
        },
      ],
    });
  });

  it("omits the session id of a lane that has never run a turn", () => {
    const { sessionId: _unbound, ...neverRan } = snapshot({ state: "active" });
    const [lane] = renderCaptainLaneListing([neverRan]).lanes;
    expect(lane).toEqual({
      lane: "discord_presence",
      targetId: "111:222",
      state: "active",
      updatedAt: "2026-08-09T10:00:00.000Z",
    });
  });

  it("never carries a continuation token or character identity into the observation surface", () => {
    const listing = renderCaptainLaneListing([snapshot()]);
    const serialized = JSON.stringify(listing);
    expect(serialized).not.toContain("continuation");
    expect(serialized).not.toContain("clankie");
    expect(serialized).not.toContain("revision");
  });

  it("bounds the listing at the public maximum", () => {
    const many = Array.from({ length: CAPTAIN_LANE_LISTING_MAX + 20 }, (_unused, index) =>
      snapshot({
        key: `lane-${String(index)}`,
        targetId: `111:${String(index)}`,
        sessionId: `session-${String(index)}`,
        updatedAt: new Date(Date.UTC(2026, 7, 9, 0, 0, index)).toISOString(),
      }),
    );
    const listing = renderCaptainLaneListing(many);
    expect(listing.lanes).toHaveLength(CAPTAIN_LANE_LISTING_MAX);
    // Truncation keeps the most recent rooms, not an arbitrary prefix.
    expect(listing.lanes[0]?.targetId).toBe(`111:${String(CAPTAIN_LANE_LISTING_MAX + 19)}`);
  });
});
