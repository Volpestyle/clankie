import { describe, expect, it } from "vitest";
import { projectPlayStory } from "../src/play-story.ts";
import type { FreePlayJournalLine } from "../src/free-play-journal.ts";
import type { FreePlayTurn } from "../src/free-play.ts";

const turn = (index: number, extra: Partial<FreePlayTurn> = {}): FreePlayTurn => ({
  turn: index,
  observationSha256: "a".repeat(64),
  framebufferSha256: null,
  monologue: `thinking about turn ${String(index)}`,
  intent: "press a",
  notes: null,
  objective: "leave the bedroom",
  objectiveRetired: null,
  interjection: null,
  reply: null,
  speak: null,
  speakSuppressed: false,
  speakWanted: false,
  action: { kind: "button_press", button: "a", holdFrames: 2 },
  outcome: "accepted",
  detail: null,
  effect: "moved north",
  effectAdvice: null,
  ...extra,
});

function header(): FreePlayJournalLine {
  return {
    kind: "header",
    schemaVersion: 1,
    runId: "play-1",
    environmentSessionId: "gba-free-play:firered:v1:run-1",
    scenarioId: "firered-bedroom-route",
    startedAt: "2026-08-15T20:00:00.000Z",
    resumedFromCheckpointId: null,
  };
}

function turnLine(index: number, extra: Partial<FreePlayTurn> = {}): FreePlayJournalLine {
  return {
    kind: "turn",
    schemaVersion: 1,
    at: `2026-08-15T20:00:${String(index).padStart(2, "0")}.000Z`,
    turn: turn(index, extra),
  };
}

describe("projectPlayStory", () => {
  it("keeps only speakWanted moments and never puts monologue on the card", () => {
    const card = projectPlayStory({
      sessionId: "play-1",
      environmentId: "pokemon-firered",
      maps: ["pallet-town", "route-1"],
      lines: [
        header(),
        turnLine(0, { speakWanted: false, monologue: "secret inner monologue" }),
        turnLine(1, { speakWanted: true, effect: "bumped Oak", objective: "leave the lab" }),
        turnLine(2, { speakWanted: true, effect: "chose Charmander", objective: "leave Pallet" }),
      ],
    });
    expect(card.turnsTaken).toBe(3);
    expect(card.lastTurnAt).toBe("2026-08-15T20:00:02.000Z");
    expect(card.objective).toBe("leave Pallet");
    expect(card.maps).toEqual(["pallet-town", "route-1"]);
    expect(card.moments).toEqual([
      { at: "2026-08-15T20:00:01.000Z", effect: "bumped Oak", toward: "leave the lab" },
      { at: "2026-08-15T20:00:02.000Z", effect: "chose Charmander", toward: "leave Pallet" },
    ]);
    expect(JSON.stringify(card)).not.toContain("secret inner monologue");
  });

  it("throws without a header rather than inventing a run", () => {
    expect(() =>
      projectPlayStory({ sessionId: "play-1", environmentId: "pokemon-firered", lines: [turnLine(0)] }),
    ).toThrow(/play_story_missing_header/u);
  });

  it("reports no settled turn while a new session is still deciding", () => {
    expect(
      projectPlayStory({ sessionId: "play-1", environmentId: "pokemon-firered", lines: [header()] }),
    ).toMatchObject({ turnsTaken: 0, lastTurnAt: null });
  });
});
