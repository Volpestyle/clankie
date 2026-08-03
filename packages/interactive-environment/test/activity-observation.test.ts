import { describe, expect, it } from "vitest";
import {
  ActivityObservationReadSchema,
  ActivityObservationSnapshotSchema,
} from "../src/activity-observation.ts";

const digest = "a".repeat(64);

describe("activity observation", () => {
  it("keeps self-authored and runner-observed activity state structurally separate", () => {
    const snapshot = ActivityObservationSnapshotSchema.parse({
      schemaVersion: 1,
      surface: "gba_emulator",
      sessionId: "play-1",
      environmentId: "pokemon-firered",
      sequence: 12,
      observedAt: "2026-08-03T02:09:16.868Z",
      selfAuthored: {
        objective: "leave Oak's lab",
        intent: "dismiss the prize-money dialog",
        commentary: "The continuation marker is visible now.",
      },
      runnerObserved: {
        outcome: "accepted",
        effect: "battle state changed",
        progress: {
          distinctTiles: 23,
          maps: ["oaks-lab"],
          turnsSinceNewTile: 4,
          actionsPerNewTile: 1.8,
        },
        framebufferSha256: digest,
      },
    });

    expect(snapshot.selfAuthored.objective).toBe("leave Oak's lab");
    expect(snapshot.runnerObserved.effect).toBe("battle state changed");
    expect("data" in snapshot.runnerObserved).toBe(false);
  });

  it("represents live-without-a-settled-turn and no-live-session without guessing", () => {
    expect(
      ActivityObservationReadSchema.parse({
        schemaVersion: 1,
        outcome: "pending",
        sessionId: "play-1",
        environmentId: "pokemon-firered",
        state: "running",
        updatedAt: "2026-08-03T02:09:16.868Z",
      }).outcome,
    ).toBe("pending");
    expect(ActivityObservationReadSchema.parse({ schemaVersion: 1, outcome: "not_playing" }).outcome).toBe(
      "not_playing",
    );
  });

  it("rejects unbounded commentary and frame bytes", () => {
    const base = {
      schemaVersion: 1,
      surface: "gba_emulator",
      sessionId: "play-1",
      environmentId: "pokemon-firered",
      sequence: 1,
      observedAt: "2026-08-03T02:09:16.868Z",
      selfAuthored: { objective: null, intent: null, commentary: "x".repeat(601) },
      runnerObserved: {
        outcome: "accepted",
        effect: null,
        progress: { distinctTiles: 1, maps: [], turnsSinceNewTile: 0, actionsPerNewTile: null },
        framebufferSha256: null,
      },
    };
    expect(ActivityObservationSnapshotSchema.safeParse(base).success).toBe(false);
    expect(
      ActivityObservationSnapshotSchema.safeParse({
        ...base,
        selfAuthored: { ...base.selfAuthored, commentary: null },
        runnerObserved: { ...base.runnerObserved, frameData: "base64" },
      }).success,
    ).toBe(false);
  });
});
