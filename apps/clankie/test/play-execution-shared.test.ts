import { describe, expect, it } from "vitest";
import { overlayText, roomEvent } from "../src/play-execution-shared.ts";

describe("play execution shared reporting", () => {
  it("bounds overlay copy and drops blank text", () => {
    expect(overlayText("  hello  ")).toBe("hello");
    expect(overlayText("   ")).toBeNull();
    expect(overlayText("x".repeat(300))).toHaveLength(256);
  });

  it("omits a blank room event", () => {
    expect(roomEvent({ turn: 3, monologue: null, effect: null, objective: null, intent: null })).toBeNull();
  });
});
