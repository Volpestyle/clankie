import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PlaySightProjection } from "../src/play-sight.ts";

describe("PlaySightProjection", () => {
  it("reports not_playing until a session attaches", () => {
    const sight = new PlaySightProjection();
    expect(sight.still().outcome).toBe("not_playing");
    expect(sight.story().outcome).toBe("not_playing");
  });

  it("returns a still from the live capture and a story from the journal", () => {
    const root = mkdtempSync(join(tmpdir(), "play-sight-"));
    const journalPath = join(root, "run.jsonl");
    writeFileSync(
      journalPath,
      [
        JSON.stringify({
          kind: "header",
          schemaVersion: 1,
          runId: "play-1",
          environmentSessionId: "gba-1",
          scenarioId: "firered-bedroom-route",
          startedAt: "2026-08-15T20:00:00.000Z",
          resumedFromCheckpointId: null,
        }),
        JSON.stringify({
          kind: "turn",
          schemaVersion: 1,
          at: "2026-08-15T20:00:01.000Z",
          turn: {
            turn: 0,
            observationSha256: "a".repeat(64),
            framebufferSha256: null,
            monologue: "thinking",
            intent: "press a",
            notes: null,
            objective: "leave the lab",
            interjection: null,
            reply: null,
            speak: null,
            speakSuppressed: false,
            speakWanted: true,
            action: { kind: "button_press", button: "a", holdFrames: 2 },
            outcome: "accepted",
            detail: null,
            effect: "bumped Oak",
          },
        }),
      ].join("\n"),
    );
    const sight = new PlaySightProjection();
    sight.attach({
      sessionId: "play-1",
      environmentId: "pokemon-firered",
      scenarioId: "firered-bedroom-route",
      startedAt: "2026-08-15T20:00:00.000Z",
      journalPath,
      capture: () => ({ png: Buffer.from("png"), width: 720, height: 480 }),
    });
    sight.noteProgress({ maps: ["oaks-lab"], objective: "leave the lab" });

    const still = sight.still();
    expect(still.outcome).toBe("still");
    if (still.outcome === "still") {
      expect(still.width).toBe(720);
      expect(still.pngBase64).toBe(Buffer.from("png").toString("base64"));
    }
    const story = sight.story();
    expect(story.outcome).toBe("card");
    if (story.outcome === "card") {
      expect(story.card.moments).toEqual([
        { at: "2026-08-15T20:00:01.000Z", effect: "bumped Oak", toward: "leave the lab" },
      ]);
      expect(story.card.maps).toEqual(["oaks-lab"]);
    }

    sight.detach("play-1");
    expect(sight.still().outcome).toBe("not_playing");
  });
});
