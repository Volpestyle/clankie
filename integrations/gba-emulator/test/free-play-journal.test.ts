import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openFreePlayJournal, parseFreePlayJournal } from "../src/free-play-journal.ts";
import type { FreePlayResult, FreePlayTurn } from "../src/free-play.ts";

const turn = (index: number): FreePlayTurn => ({
  turn: index,
  observationSha256: "a".repeat(64),
  framebufferSha256: null,
  monologue: `thinking about turn ${String(index)}`,
  intent: "press a",
  notes: null,
  objective: "leave the bedroom",
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
});

const result = (turns: FreePlayTurn[]): FreePlayResult => ({
  turns,
  accepted: turns.length,
  progress: { distinctTiles: 3, maps: ["pallet-town/house-1f"], turnsSinceNewTile: 0, actionsPerNewTile: 1 },
  volition: { offered: turns.length, taken: 1, suppressed: 0, skipped: 0 },
  coherence: 0.5,
  longestUnchangedRun: 1,
});

describe("free-play journal", () => {
  it("records header, every turn, and the summary as one parseable file", () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "play-journal-"));
    const clock = () => new Date("2026-07-27T02:30:00.000Z");
    const journal = openFreePlayJournal({
      rootDir,
      runId: "embodiment-abc123",
      environmentSessionId: "gba-free-play:firered-bedroom-route:v1:run-1",
      scenarioId: "firered-bedroom-route",
      resumedFromCheckpointId: "2026-07-26T15-55-24-710Z-oaks-lab-starter-menu",
      clock,
    });
    const turns = [turn(0), turn(1)];
    for (const record of turns) journal.turn(record);
    journal.summary({
      outcome: "stopped",
      result: result(turns),
      durationMs: 12_345,
      framesPublished: 40,
      framesDropped: 0,
      checkpointId: "2026-07-27T02-40-00-000Z-asked-play",
    });

    const lines = parseFreePlayJournal(readFileSync(journal.path, "utf8"));
    expect(lines.map((line) => line.kind)).toEqual(["header", "turn", "turn", "summary"]);
    expect(lines[0]).toMatchObject({
      runId: "embodiment-abc123",
      scenarioId: "firered-bedroom-route",
      resumedFromCheckpointId: "2026-07-26T15-55-24-710Z-oaks-lab-starter-menu",
    });
    expect(lines[1]).toMatchObject({ turn: { turn: 0, monologue: "thinking about turn 0" } });
    expect("speechDeliveryId" in (lines[1] ?? {})).toBe(false);
    expect(lines[3]).toMatchObject({
      outcome: "stopped",
      turnsTaken: 2,
      progress: { distinctTiles: 3 },
      volition: { taken: 1 },
      coherence: 0.5,
    });
  });

  it("gives every run its own file, never overwriting the previous one", () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "play-journal-runs-"));
    const at = { value: new Date("2026-07-27T02:30:00.000Z") };
    const open = () =>
      openFreePlayJournal({
        rootDir,
        runId: "embodiment-abc123",
        environmentSessionId: "session",
        scenarioId: "scenario",
        clock: () => at.value,
      });
    const first = open();
    at.value = new Date("2026-07-27T03:30:00.000Z");
    const second = open();
    expect(second.path).not.toBe(first.path);
    expect(readdirSync(rootDir)).toHaveLength(2);
  });

  it("reports an append failure instead of killing the playthrough", () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "play-journal-error-"));
    const errors: unknown[] = [];
    const journal = openFreePlayJournal({
      rootDir,
      runId: "run",
      environmentSessionId: "session",
      scenarioId: "scenario",
      onError: (error) => errors.push(error),
    });
    rmSync(rootDir, { recursive: true, force: true });
    journal.turn(turn(0));
    expect(errors).toHaveLength(1);
  });

  it("joins a reported turn to the voice delivery id without rewriting old lines", () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "play-journal-speech-"));
    const journal = openFreePlayJournal({
      rootDir,
      runId: "run",
      environmentSessionId: "session",
      scenarioId: "scenario",
      clock: () => new Date("2026-08-15T21:00:00.000Z"),
    });
    journal.turn(turn(0), { speechDeliveryId: "play-turn-1" });
    const lines = parseFreePlayJournal(readFileSync(journal.path, "utf8"));
    expect(lines[1]).toMatchObject({
      kind: "turn",
      speechDeliveryId: "play-turn-1",
      turn: { turn: 0 },
    });
  });
});
