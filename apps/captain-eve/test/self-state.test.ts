import { describe, expect, it } from "vitest";
import type { CaptainLaneSnapshot } from "@clankie/captain-runtime";
import {
  projectCaptainSelfState,
  renderCaptainSelfState,
  type CaptainSelfStateInput,
} from "../lib/self-state.ts";

const NOW = new Date("2026-07-25T12:00:00.000Z");

function lane(overrides: Partial<CaptainLaneSnapshot> & Pick<CaptainLaneSnapshot, "lane">) {
  return {
    key: JSON.stringify(["clankie", overrides.lane, overrides.targetId ?? "target"]),
    characterId: "clankie",
    targetId: "target",
    state: "waiting",
    revision: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  } as CaptainLaneSnapshot;
}

function input(overrides: Partial<CaptainSelfStateInput> = {}): CaptainSelfStateInput {
  return { conversations: [], lanes: [], now: NOW, ...overrides };
}

describe("captain self state", () => {
  it("reports a Discord room the operator lane is not in", () => {
    const state = projectCaptainSelfState(
      input({
        conversations: [
          { conversationId: "global-default", sessionState: "waiting", updatedAt: NOW.toISOString() },
        ],
        lanes: [lane({ lane: "discord_presence", targetId: "guild-1:channel-9" })],
        here: { lane: "operator", targetId: "global-default" },
      }),
    );

    expect(state.rooms).toEqual([
      {
        lane: "operator",
        targetId: "global-default",
        here: true,
        active: true,
        updatedAt: NOW.toISOString(),
      },
      {
        lane: "discord_presence",
        targetId: "guild-1:channel-9",
        here: false,
        active: true,
        updatedAt: NOW.toISOString(),
      },
    ]);
    expect(renderCaptainSelfState(state)).toContain("guild-1:channel-9");
  });

  it("puts the current room first even when another room is more recent", () => {
    const state = projectCaptainSelfState(
      input({
        lanes: [
          lane({ lane: "gameplay", targetId: "firered", updatedAt: NOW.toISOString() }),
          lane({ lane: "discord_voice", targetId: "guild-1:vc-2", updatedAt: "2026-07-25T11:59:00.000Z" }),
        ],
        here: { lane: "discord_voice", targetId: "guild-1:vc-2" },
      }),
    );

    expect(state.rooms.map((room) => room.targetId)).toEqual(["guild-1:vc-2", "firered"]);
    expect(state.rooms[0]?.here).toBe(true);
  });

  it("marks by lane alone when the hook channel carries no target id", () => {
    // Lifecycle-hook channels frequently omit `captainTargetId`; resolving the
    // full address would throw and take the turn down.
    const state = projectCaptainSelfState(
      input({
        lanes: [lane({ lane: "discord_voice", targetId: "guild-1:vc-2" })],
        here: { lane: "discord_voice", targetId: undefined },
      }),
    );

    expect(state.rooms[0]?.here).toBe(true);
  });

  it("drops rooms that settled outside the recent window but keeps active ones", () => {
    const state = projectCaptainSelfState(
      input({
        lanes: [
          lane({
            lane: "discord_voice",
            targetId: "stale",
            state: "completed",
            updatedAt: "2026-07-25T11:00:00.000Z",
          }),
          lane({
            lane: "discord_presence",
            targetId: "just-settled",
            state: "completed",
            updatedAt: "2026-07-25T11:59:00.000Z",
          }),
          lane({ lane: "gameplay", targetId: "live", state: "active" }),
        ],
      }),
    );

    expect(state.rooms.map((room) => room.targetId)).toEqual(["live", "just-settled"]);
    expect(state.rooms.find((room) => room.targetId === "just-settled")?.active).toBe(false);
    expect(renderCaptainSelfState(state)).toContain("(settled)");
  });

  it("does not double-count a legacy tui lane row against its operator conversation", () => {
    const state = projectCaptainSelfState(
      input({
        conversations: [
          { conversationId: "global-default", sessionState: "active", updatedAt: NOW.toISOString() },
        ],
        lanes: [lane({ lane: "tui", targetId: "global-default" })],
      }),
    );

    expect(state.rooms).toHaveLength(1);
    expect(state.rooms[0]?.lane).toBe("operator");
  });

  it("bounds the summary and says how much it withheld", () => {
    const state = projectCaptainSelfState(
      input({
        lanes: Array.from({ length: 30 }, (_unused, index) =>
          lane({ lane: "discord_presence", targetId: `guild-1:channel-${String(index)}`, state: "active" }),
        ),
      }),
    );

    expect(state.rooms).toHaveLength(24);
    expect(state.truncated).toBe(6);
    expect(renderCaptainSelfState(state)).toContain("and 6 more not shown");
  });

  it("carries no continuation token into the projection", () => {
    // The projection's only lane source is `CaptainLaneSnapshot`, which has no
    // token field at all — the fence is structural, not a filter that could be
    // forgotten. A resume state does carry one, so guard against it being
    // swapped in later.
    const resumeShaped = { ...lane({ lane: "discord_voice" }), continuationToken: "secret-token" };
    const state = projectCaptainSelfState(
      input({ lanes: [resumeShaped as CaptainLaneSnapshot], now: NOW }),
    );

    const rendered = renderCaptainSelfState(state);
    expect(JSON.stringify(state)).not.toContain("secret-token");
    expect(rendered).not.toContain("secret-token");
  });

  it("says so plainly when this is the only room", () => {
    expect(renderCaptainSelfState(projectCaptainSelfState(input()))).toContain("only open room");
  });
});
