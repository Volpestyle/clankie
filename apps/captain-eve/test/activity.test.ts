import type { ActivityObservationRead } from "@clankie/api-client";
import { describe, expect, it, vi } from "vitest";
import { observeCurrentActivity } from "../lib/activity.ts";

describe("captain activity self-observation", () => {
  it("returns the typed projection without blending its provenance fields", async () => {
    const read: ActivityObservationRead = {
      schemaVersion: 1,
      outcome: "snapshot",
      snapshot: {
        schemaVersion: 1,
        surface: "gba_emulator",
        sessionId: "session-1",
        environmentId: "pokemon-firered",
        sequence: 8,
        observedAt: "2026-08-02T20:00:00.000Z",
        selfAuthored: {
          objective: "Explore Pallet Town",
          intent: "Walk toward the southern exit",
          commentary: "The lab is behind me now.",
        },
        runnerObserved: {
          outcome: "accepted",
          effect: "Moved one tile south",
          progress: {
            distinctTiles: 14,
            maps: ["Pallet Town"],
            turnsSinceNewTile: 0,
            actionsPerNewTile: 1.5,
          },
          framebufferSha256: "a".repeat(64),
        },
      },
    };
    const getCurrentActivityObservation = vi.fn(async () => read);

    const result = await observeCurrentActivity({ getCurrentActivityObservation });

    expect(result).toBe(read);
    expect(getCurrentActivityObservation).toHaveBeenCalledOnce();
    if (result.outcome !== "snapshot") throw new Error("expected snapshot");
    expect(result.snapshot.selfAuthored.intent).toBe("Walk toward the southern exit");
    expect(result.snapshot.runnerObserved.effect).toBe("Moved one tile south");
  });
});
