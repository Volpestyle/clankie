import { describe, expect, it } from "vitest";
import { nextStepLine } from "../src/next-step.ts";

const configured = { remoteAccessConfigured: true, directRouteConfigured: false };
const bare = { remoteAccessConfigured: false, directRouteConfigured: false };

describe("nextStepLine", () => {
  it("sends a configured doorway that holds no connection to the captain restart", () => {
    expect(nextStepLine({ doorway: { state: "unavailable" }, ...configured })).toContain("clankie restart");
  });

  it("points a working doorway, or a direct route, at pairing", () => {
    expect(nextStepLine({ doorway: { state: "connected" }, ...configured })).toContain("clankie pair");
    expect(
      nextStepLine({
        doorway: { state: "disabled" },
        remoteAccessConfigured: false,
        directRouteConfigured: true,
      }),
    ).toBe("Pair a phone or tablet: run `clankie pair` (or /pair).");
  });

  it("offers both ways to reach him away from home before anything is set up", () => {
    const line = nextStepLine({ doorway: { state: "disabled" }, ...bare });
    expect(line).toContain("clankie remote-access on");
    expect(line).toContain("clankie gateway direct");
  });
});
