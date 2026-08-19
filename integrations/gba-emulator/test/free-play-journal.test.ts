import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FreePlayJournalSummarySchema,
  openFreePlayJournal,
  parseFreePlayJournal,
} from "../src/free-play-journal.ts";
import { encodeFramebufferPng } from "../src/framebuffer-png.ts";
import type { FreePlayResult, FreePlayTurn, FreePlayTurnEvidence } from "../src/free-play.ts";

const turn = (index: number): FreePlayTurn => ({
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
});

const result = (turns: FreePlayTurn[]): FreePlayResult => ({
  turns,
  accepted: turns.length,
  progress: { distinctTiles: 3, maps: ["pallet-town/house-1f"], turnsSinceNewTile: 0, actionsPerNewTile: 1 },
  volition: { offered: turns.length, taken: 1, suppressed: 0, skipped: 0 },
  coherence: 0.5,
  longestUnchangedRun: 1,
  longestRecurringRun: 6,
  objectivesRetired: 1,
});

const evidence = (): FreePlayTurnEvidence => ({
  decision: { observations: [], provenance: { body: "local", coreId: "test", real: false } },
  immediatePreAction: { observations: [], provenance: { body: "local", coreId: "test", real: false } },
  postAction: { observations: [], provenance: { body: "local", coreId: "test", real: false } },
  actionResult: {
    source: "environment",
    result: {
      schemaVersion: 1,
      actionId: "11111111-1111-4111-8111-111111111111",
      sessionId: "session",
      updatedAt: "2026-08-15T21:00:00.000Z",
      status: "completed",
      acceptedGoalVersion: 1,
      outcome: { transcript: ["complete structured result"] },
    },
  },
  progressBefore: { distinctTiles: 1, maps: ["map"], turnsSinceNewTile: 0, actionsPerNewTile: null },
  progressAfter: { distinctTiles: 1, maps: ["map"], turnsSinceNewTile: 1, actionsPerNewTile: null },
  signals: {
    refusedHere: [],
    stalledForTurns: null,
    repeatingForTurns: null,
    recurringForTurns: null,
    objectiveForTurns: null,
    localeForTurns: null,
    previousObjective: "leave the bedroom",
    previousNotes: null,
    retiredObjective: null,
    objectiveRecovery: false,
    verifiedInteractions: [],
    decisionPreemptions: 0,
  },
  timing: {
    decisionStartedAt: "2026-08-15T21:00:00.000Z",
    decisionSettledAt: "2026-08-15T21:00:01.000Z",
    actionStartedAt: "2026-08-15T21:00:01.000Z",
    actionSettledAt: "2026-08-15T21:00:02.000Z",
  },
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
    for (const record of turns) journal.turn(record, evidence());
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
      schemaVersion: 2,
      runId: "embodiment-abc123",
      scenarioId: "firered-bedroom-route",
      resumedFromCheckpointId: "2026-07-26T15-55-24-710Z-oaks-lab-starter-menu",
    });
    expect(lines[1]).toMatchObject({
      schemaVersion: 2,
      turn: { turn: 0, monologue: "thinking about turn 0" },
      evidence: { actionResult: { result: { outcome: { transcript: ["complete structured result"] } } } },
    });
    expect("speechDeliveryId" in (lines[1] ?? {})).toBe(false);
    expect(lines[3]).toMatchObject({
      outcome: "stopped",
      turnsTaken: 2,
      progress: { distinctTiles: 3 },
      volition: { taken: 1 },
      coherence: 0.5,
      longestRecurringRun: 6,
      objectivesRetired: 1,
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
    expect(readdirSync(rootDir).filter((name) => name.endsWith(".jsonl"))).toHaveLength(2);
  });

  it("captures bounded milestone screenshots beside the journal", () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "play-journal-screenshots-"));
    const journal = openFreePlayJournal({
      rootDir,
      runId: "run",
      environmentSessionId: "session",
      scenarioId: "scenario",
      clock: () => new Date("2026-08-19T12:00:00.000Z"),
    });
    const png = encodeFramebufferPng({ width: 2, height: 2, bytes: new Uint8Array(8) });
    let captures = 0;
    const framePng = () => {
      captures += 1;
      return png;
    };
    const turns = Array.from({ length: 80 }, (_, index) => ({
      ...turn(index),
      ...(index > 0 ? { outcome: "rejected_by_adapter" as const } : {}),
    }));
    for (const record of turns) journal.turn(record, evidence(), { framePng });
    journal.summary({
      outcome: "stopped",
      result: result(turns),
      durationMs: 1,
      framesPublished: 1,
      framesDropped: 0,
      framePng,
    });

    const screenshots = parseFreePlayJournal(readFileSync(journal.path, "utf8")).flatMap((line) =>
      line.kind !== "header" && line.schemaVersion === 2 && line.screenshot !== undefined
        ? [line.screenshot]
        : [],
    );
    expect(captures).toBe(64);
    expect(screenshots).toHaveLength(64);
    expect(screenshots[0]?.reasons).toEqual(["initial"]);
    expect(screenshots[1]?.reasons).toEqual(["failure"]);
    expect(screenshots[25]?.reasons).toEqual(["interval", "failure"]);
    expect(screenshots.at(-1)?.reasons).toEqual(["terminal"]);
    for (const screenshot of screenshots) {
      const bytes = readFileSync(path.join(rootDir, screenshot.path));
      expect(screenshot).toMatchObject({ byteLength: bytes.byteLength, width: 2, height: 2 });
      expect(screenshot.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
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
    journal.turn(turn(0), evidence());
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
    journal.turn(turn(0), evidence(), {
      speechDeliveryId: "play-turn-1",
      narrationEvent: "moved north (working toward: leave the bedroom)",
    });
    const lines = parseFreePlayJournal(readFileSync(journal.path, "utf8"));
    expect(lines[1]).toMatchObject({
      kind: "turn",
      speechDeliveryId: "play-turn-1",
      narrationEvent: "moved north (working toward: leave the bedroom)",
      turn: { turn: 0 },
    });
  });

  it("keeps V1 journals readable with no invented evidence", () => {
    const lines = parseFreePlayJournal(
      [
        JSON.stringify({
          kind: "header",
          schemaVersion: 1,
          runId: "legacy",
          environmentSessionId: "legacy-session",
          scenarioId: "legacy-scenario",
          startedAt: "2026-07-27T02:30:00.000Z",
          resumedFromCheckpointId: null,
        }),
        JSON.stringify({
          kind: "turn",
          schemaVersion: 1,
          at: "2026-07-27T02:30:01.000Z",
          turn: turn(0),
        }),
      ].join("\n"),
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ schemaVersion: 1, kind: "turn" });
    expect("evidence" in (lines[1] ?? {})).toBe(false);
  });

  it("keeps V2 overworld evidence readable from before exit actionability", () => {
    const oldEvidence = evidence();
    if (oldEvidence.postAction === null) throw new Error("expected post-action evidence");
    oldEvidence.postAction.observations = [
      {
        schemaVersion: 1,
        observationId: "legacy-overworld",
        sessionId: "legacy-session",
        characterId: "clankie",
        worldId: "kanto",
        goalVersion: 1,
        capturedAt: "2026-08-15T21:00:00.000Z",
        frame: 1,
        kind: "overworld",
        data: {
          position: { mapId: "pallet-town/players-house-1f", x: 17, y: 9 },
          facing: "west",
          surroundings: null,
          mapSize: null,
          minimap: null,
          exits: {
            warps: [{ x: 12, y: 15, destination: "pallet-town" }],
            connections: [],
          },
          ramStateSha256: "a".repeat(64),
        },
      },
    ];
    const line = {
      kind: "turn",
      schemaVersion: 2,
      at: "2026-08-15T21:00:00.000Z",
      turn: turn(0),
      evidence: oldEvidence,
    };

    expect(parseFreePlayJournal(JSON.stringify(line))).toHaveLength(1);
  });

  it("defaults loop metrics on summaries written before they existed", () => {
    const legacy = FreePlayJournalSummarySchema.parse({
      kind: "summary",
      schemaVersion: 1,
      at: "2026-08-15T21:00:00.000Z",
      outcome: "stopped",
      turnsTaken: 1,
      accepted: 1,
      durationMs: 1,
      framesPublished: 1,
      framesDropped: 0,
      checkpointId: null,
      progress: { distinctTiles: 1, maps: ["house"], turnsSinceNewTile: 1, actionsPerNewTile: null },
      volition: { offered: 1, taken: 0, suppressed: 0 },
      coherence: null,
    });

    expect(legacy).toMatchObject({ longestRecurringRun: 0, objectivesRetired: 0 });
  });
});
