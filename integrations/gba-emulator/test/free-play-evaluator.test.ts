import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateFreePlayJournalCli } from "../scripts/evaluate-free-play-journal.ts";
import { evaluateFreePlayJournal } from "../src/free-play-evaluator.ts";

const at = "2026-08-17T01:00:00.000Z";
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "free-play-evaluator-"));
  tempDirs.push(directory);
  return directory;
}

async function write(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

function header(schemaVersion: 1 | 2 = 2) {
  return {
    kind: "header",
    schemaVersion,
    runId: "run-1",
    environmentSessionId: "session-1",
    scenarioId: "world:pokemon-firered",
    startedAt: at,
    resumedFromCheckpointId: null,
  };
}

function journal(...turns: unknown[]): string {
  return [header(), ...turns].map((line) => JSON.stringify(line)).join("\n");
}

function observations(x: number) {
  const base = {
    schemaVersion: 1,
    sessionId: "session-1",
    characterId: "clankie",
    worldId: "kanto",
    goalVersion: 1,
    capturedAt: at,
    frame: x,
  } as const;
  return [
    {
      ...base,
      observationId: `scene-${String(x)}`,
      kind: "scene",
      data: { mode: "overworld", inputReady: true, waitingForDialogAdvance: false },
    },
    {
      ...base,
      observationId: `overworld-${String(x)}`,
      kind: "overworld",
      data: {
        position: { mapId: "PALLET_TOWN", x, y: 6 },
        facing: "east",
        surroundings: null,
        mapSize: null,
        minimap: null,
        exits: null,
        ramStateSha256: "a".repeat(64),
      },
    },
  ];
}

function evidence(start: number, end: number, status: "completed" | "failed") {
  const provenance = { body: "world", sessionId: "session-1", worldId: "kanto", bodyGeneration: 3 };
  return {
    decision: { observations: observations(start), provenance },
    immediatePreAction: { observations: observations(start), provenance },
    postAction: { observations: observations(end), provenance },
    actionResult: {
      source: "environment",
      result:
        status === "completed"
          ? {
              schemaVersion: 1,
              actionId: `action-${String(start)}`,
              sessionId: "session-1",
              updatedAt: at,
              status,
              acceptedGoalVersion: 1,
              outcome: { steps: end - start, arrived: true },
            }
          : {
              schemaVersion: 1,
              actionId: `action-${String(start)}`,
              sessionId: "session-1",
              updatedAt: at,
              status,
              acceptedGoalVersion: 1,
              errorCode: "no_path_to_target",
              message: "blocked",
              retryable: false,
            },
    },
    progressBefore: {
      distinctTiles: 1,
      maps: ["PALLET_TOWN"],
      turnsSinceNewTile: 4,
      actionsPerNewTile: null,
    },
    progressAfter: {
      distinctTiles: end === start ? 1 : 2,
      maps: ["PALLET_TOWN"],
      turnsSinceNewTile: end === start ? 5 : 0,
      actionsPerNewTile: end === start ? null : 1,
    },
    signals: {
      refusedHere: [],
      stalledForTurns: null,
      repeatingForTurns: null,
      recurringForTurns: null,
      objectiveForTurns: null,
      localeForTurns: null,
      previousObjective: "walk east",
      previousNotes: "the north path is blocked",
      retiredObjective: null,
      objectiveRecovery: false,
      verifiedInteractions: [],
      decisionPreemptions: 0,
    },
    timing: {
      decisionStartedAt: "2026-08-17T01:00:00.000Z",
      decisionSettledAt: "2026-08-17T01:00:02.000Z",
      actionStartedAt: "2026-08-17T01:00:02.000Z",
      actionSettledAt: "2026-08-17T01:00:03.000Z",
    },
  };
}

function turn(index: number, outcome: "accepted" | "rejected_by_adapter", deliveryId: string) {
  return {
    kind: "turn",
    schemaVersion: 2,
    at,
    turn: {
      turn: index,
      observationSha256: "b".repeat(64),
      framebufferSha256: null,
      monologue: "the east route fits the goal",
      intent: "walk east next",
      notes: "the north path is blocked",
      objective: "walk east",
      objectiveRetired: null,
      interjection: null,
      reply: null,
      speak: null,
      speakSuppressed: false,
      speakWanted: true,
      action: { kind: "walk_to", x: 8 + index, y: 6 },
      outcome,
      detail: outcome,
      effect: outcome === "accepted" ? "walked east" : "rejected, nothing ran",
      effectAdvice: null,
    },
    evidence: evidence(5, outcome === "accepted" ? 8 : 5, outcome === "accepted" ? "completed" : "failed"),
    speechDeliveryId: deliveryId,
    narrationEvent: `${outcome} (working toward: walk east)`,
  };
}

describe("free-play evaluator", () => {
  it("joins exact voice receipts and terminal lifecycle without inventing a summary", () => {
    const journal = [
      {
        kind: "header",
        schemaVersion: 2,
        runId: "run-1",
        environmentSessionId: "session-1",
        scenarioId: "world:pokemon-firered",
        startedAt: at,
        resumedFromCheckpointId: null,
      },
      turn(0, "rejected_by_adapter", "delivery-suppressed"),
      turn(1, "accepted", "delivery-played"),
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");
    const report = evaluateFreePlayJournal({
      journal,
      lifecycleEvents: JSON.stringify({
        type: "embodiment.session.failed",
        occurredAt: "2026-08-17T01:05:00.000Z",
        data: { sessionId: "run-1", outcome: "lease_lapsed" },
      }),
      voiceReceipts: [
        {
          type: "discord.voice.possessor_narration_suppressed",
          occurredAt: at,
          data: { deliveryId: "delivery-suppressed", reason: "rate_limited" },
        },
        {
          type: "discord.voice.response",
          occurredAt: at,
          data: { deliveryId: "delivery-played", trigger: "narration", playbackMs: 800 },
        },
        {
          type: "discord.voice.response",
          occurredAt: at,
          data: { deliveryId: "unrelated", trigger: "narration", playbackMs: 800 },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    });

    expect(report.run.terminal).toMatchObject({
      source: "lifecycle",
      outcome: "lease_lapsed",
      summaryPresent: false,
    });
    expect(report.turns[0]?.verdicts).toMatchObject({
      narration: "suppressed",
      rejectionRecovery: "recovered",
      movementEffectiveness: "ineffective",
    });
    expect(report.turns[1]?.verdicts).toMatchObject({
      narration: "played",
      movementEffectiveness: "effective",
      sceneActionAppropriateness: "appropriate",
    });
    expect(report.aggregate.timing).toMatchObject({
      decision: { averageMs: 2_000 },
      action: { averageMs: 1_000 },
    });
  });

  it("scores intent against the action it was written beside, not the next turn's", () => {
    const first = turn(0, "rejected_by_adapter", "delivery-0");
    const replanned = turn(1, "accepted", "delivery-1");
    // He reacted to the rejection: a different intent and the action to match.
    // Scored against the previous turn's intent this read as misaligned, which
    // rewarded repeating a refused action over adapting to it.
    replanned.turn.intent = "press A to talk to Oak";
    replanned.turn.action = { kind: "button_press", button: "a", holdFrames: 2, repeat: 1 } as never;
    const report = evaluateFreePlayJournal({ journal: journal(first, replanned) });

    expect(report.turns[0]?.verdicts.intentToAction).toBe("aligned");
    expect(report.turns[1]?.verdicts.intentToAction).toBe("aligned");
    expect(report.aggregate.intentToAction).toEqual({ aligned: 2 });
  });

  it("reads a settled model response so an unheard narration is not a missing trail", () => {
    const spoken = turn(0, "accepted", "delivery-spoken");
    const unheard = turn(1, "accepted", "delivery-unheard");
    const broken = turn(2, "accepted", "delivery-failed");
    const report = evaluateFreePlayJournal({
      journal: journal(spoken, unheard, broken),
      voiceReceipts: [
        {
          type: "discord.voice.model_response",
          occurredAt: at,
          data: { deliveryId: "delivery-spoken", phase: "completed", outcome: "audio" },
        },
        {
          type: "discord.voice.response",
          occurredAt: at,
          data: { deliveryId: "delivery-spoken", trigger: "narration", playbackMs: 800 },
        },
        {
          type: "discord.voice.model_response",
          occurredAt: at,
          data: { deliveryId: "delivery-unheard", phase: "requested" },
        },
        {
          type: "discord.voice.model_response",
          occurredAt: at,
          data: { deliveryId: "delivery-unheard", phase: "completed", outcome: "silent", audioBytes: 0 },
        },
        {
          type: "discord.voice.model_response",
          occurredAt: at,
          data: { deliveryId: "delivery-failed", phase: "failed" },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    });

    expect(report.turns.map((entry) => entry.verdicts.narration)).toEqual(["played", "unspoken", "failed"]);
  });

  it("keeps a narration with no receipt at all distinguishable from one that settled", () => {
    const report = evaluateFreePlayJournal({ journal: journal(turn(0, "accepted", "delivery-orphan")) });

    expect(report.turns[0]?.verdicts.narration).toBe("attempted_no_receipt");
  });

  it("keeps V1 movement unknown when no semantic start/end evidence exists", () => {
    const legacy = turn(0, "rejected_by_adapter", "delivery-legacy");
    const report = evaluateFreePlayJournal({
      journal: [
        header(1),
        { kind: "turn", schemaVersion: 1, at, turn: legacy.turn, speechDeliveryId: legacy.speechDeliveryId },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    });

    expect(report.turns[0]?.movement).toMatchObject({ start: null, end: null, effectiveness: "unknown" });
    expect(report.aggregate.movementEffectiveness).toEqual({ unknown: 1 });
  });

  it("uses the canonical state-root defaults for lifecycle and voice joins", async () => {
    const root = await tempDir();
    const stateRoot = join(root, "state");
    const xdgState = join(root, "xdg-state");
    const journalPath = join(root, "journal.jsonl");
    await write(journalPath, journal(turn(0, "accepted", "delivery-played")));
    await write(
      join(stateRoot, "events.jsonl"),
      JSON.stringify({
        type: "embodiment.session.stopped",
        occurredAt: at,
        data: { sessionId: "run-1", outcome: "completed" },
      }),
    );
    await write(
      join(xdgState, "clankie", "discord-live-receipts.jsonl"),
      JSON.stringify({ type: "discord.voice.response", data: { deliveryId: "delivery-played" } }),
    );

    const report = JSON.parse(
      evaluateFreePlayJournalCli([journalPath], { CLANKIE_STATE: stateRoot, XDG_STATE_HOME: xdgState }),
    );
    expect(report.run.terminal).toMatchObject({ source: "lifecycle", outcome: "completed" });
    expect(report.turns[0].verdicts.narration).toBe("played");
  });

  it("honors canonical event-log and receipt-path overrides", async () => {
    const root = await tempDir();
    const journalPath = join(root, "journal.jsonl");
    const eventsPath = join(root, "custom-events.jsonl");
    const receiptsPath = join(root, "custom-receipts.jsonl");
    await write(journalPath, journal(turn(0, "accepted", "delivery-played")));
    await write(
      eventsPath,
      JSON.stringify({
        type: "embodiment.session.failed",
        occurredAt: at,
        data: { sessionId: "run-1", outcome: "lease_lapsed" },
      }),
    );
    await write(
      receiptsPath,
      JSON.stringify({
        type: "discord.voice.possessor_narration_suppressed",
        data: { deliveryId: "delivery-played" },
      }),
    );

    const report = JSON.parse(
      evaluateFreePlayJournalCli([journalPath], {
        CLANKIE_EVENT_LOG: eventsPath,
        DISCORD_BRIDGE_RECEIPT_PATH: receiptsPath,
      }),
    );
    expect(report.run.terminal).toMatchObject({ source: "lifecycle", outcome: "lease_lapsed" });
    expect(report.turns[0].verdicts.narration).toBe("suppressed");
  });

  it.each(["--events", "--voice-receipts"])("errors when explicit %s input does not exist", async (flag) => {
    const root = await tempDir();
    const journalPath = join(root, "journal.jsonl");
    await write(journalPath, journal());

    expect(() => evaluateFreePlayJournalCli([journalPath, flag, join(root, "missing.jsonl")], {})).toThrow(
      /ENOENT/u,
    );
  });

  it.each(["CLANKIE_EVENT_LOG", "DISCORD_BRIDGE_RECEIPT_PATH"])(
    "errors when explicit %s override does not exist",
    async (name) => {
      const root = await tempDir();
      const journalPath = join(root, "journal.jsonl");
      await write(journalPath, journal());

      expect(() =>
        evaluateFreePlayJournalCli([journalPath], { [name]: join(root, "missing.jsonl") }),
      ).toThrow(/ENOENT/u);
    },
  );
});
