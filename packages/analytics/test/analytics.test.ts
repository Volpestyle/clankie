import { describe, expect, it } from "vitest";
import { minimizeProperties } from "../src/index.ts";

describe("analytics minimization", () => {
  it("drops content-bearing fields", () => {
    expect(
      minimizeProperties({ missionId: "m1", prompt: "private", terminalOutput: "secret", durationMs: 10 }),
    ).toEqual({
      missionId: "m1",
      durationMs: 10,
    });
  });
});
