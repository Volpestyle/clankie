import { describe, expect, it } from "vitest";
import { overlayText, roomEvent } from "../src/play-execution-shared.ts";

describe("play execution shared reporting", () => {
  it("bounds overlay copy and drops blank text", () => {
    expect(overlayText("  hello  ")).toBe("hello");
    expect(overlayText("   ")).toBeNull();
    expect(overlayText("x".repeat(300))).toHaveLength(256);
  });

  it("formats a room event from the settled turn fields", () => {
    expect(
      roomEvent({
        turn: 3,
        monologue: "heading up",
        effect: "stepped onto route 2",
        objective: "reach pewter",
        intent: "walk north",
      }),
    ).toBe(
      [
        "turn=3",
        "thought=heading up",
        "observed=stepped onto route 2",
        "goal=reach pewter",
        "next=walk north",
      ].join("\n"),
    );
    expect(roomEvent({ turn: 3, monologue: null, effect: null, objective: null, intent: null })).toBeNull();
  });
});
