import { describe, expect, it } from "vitest";
import { captainLaneAddress, captainLaneInstructions } from "../lib/lanes/context.ts";

describe("Eve captain lane context", () => {
  it("maps the existing HTTP captain contract to the authenticated TUI lane", () => {
    expect(captainLaneAddress({ kind: "http", continuationToken: "private" }, "clankie")).toEqual({
      characterId: "clankie",
      lane: "tui",
      targetId: "operator",
    });
  });

  it("requires explicit durable targets for voice and gameplay channel contracts", () => {
    expect(
      captainLaneAddress(
        {
          kind: "discord-voice",
          metadata: { captainLane: "discord_voice", captainTargetId: "guild-1:voice-1" },
        },
        "clankie",
      ),
    ).toEqual({ characterId: "clankie", lane: "discord_voice", targetId: "guild-1:voice-1" });
    expect(
      captainLaneAddress(
        {
          kind: "schedule",
          metadata: { captainLane: "gameplay", captainTargetId: "world-1" },
        },
        "clankie",
      ),
    ).toEqual({ characterId: "clankie", lane: "gameplay", targetId: "world-1" });
    expect(() => captainLaneAddress({ kind: "discord-voice" }, "clankie")).toThrow(/captainTargetId/);
  });

  it("adds lane-local instructions without including continuation authority", () => {
    for (const [lane, kind, targetId] of [
      ["tui", "http", "operator"],
      ["discord_voice", "discord-voice", "guild-1:voice-1"],
      ["gameplay", "schedule", "world-1"],
    ] as const) {
      const markdown = captainLaneInstructions({
        kind,
        metadata: { captainLane: lane, captainTargetId: targetId },
        continuationToken: `secret-${lane}`,
      });
      expect(markdown).toContain("same Clankie");
      expect(markdown).toContain("one agent definition, soul, provider identity, and character ID");
      expect(markdown).not.toContain(`secret-${lane}`);
    }
  });
});
