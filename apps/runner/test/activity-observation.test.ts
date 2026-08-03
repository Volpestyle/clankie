import { describe, expect, it } from "vitest";
import { ActivityObservationProjection } from "../src/activity-observation.ts";

function snapshot(sessionId: string, sequence: number) {
  return {
    schemaVersion: 1 as const,
    surface: "gba_emulator" as const,
    sessionId,
    environmentId: "pokemon-firered" as const,
    sequence,
    observedAt: "2026-08-03T02:09:16.868Z",
    selfAuthored: { objective: null, intent: null, commentary: null },
    runnerObserved: {
      outcome: "accepted" as const,
      effect: "moved north",
      progress: { distinctTiles: 2, maps: ["pallet-town"], turnsSinceNewTile: 0, actionsPerNewTile: 1 },
      framebufferSha256: null,
    },
  };
}

describe("activity observation projection", () => {
  it("publishes a defensive latest snapshot and rejects sequence regression", () => {
    const projection = new ActivityObservationProjection();
    projection.publish(snapshot("play-1", 3));
    const current = projection.current();
    expect(current?.sequence).toBe(3);
    if (current) current.runnerObserved.progress.maps.push("mutated");
    expect(projection.current()?.runnerObserved.progress.maps).toEqual(["pallet-town"]);
    expect(() => projection.publish(snapshot("play-1", 2))).toThrow(/sequence_regressed/u);
  });

  it("clears only the matching session", () => {
    const projection = new ActivityObservationProjection();
    projection.publish(snapshot("play-2", 0));
    projection.clear("play-1");
    expect(projection.current()?.sessionId).toBe("play-2");
    projection.clear("play-2");
    expect(projection.current()).toBeUndefined();
  });
});
