import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GbaEmulatorObservation } from "@clankie/interactive-environment";
import { describe, expect, it } from "vitest";
import type { FreePlayMind, FreePlayView } from "../src/free-play.ts";
import {
  FreePlayCompetenceOperatorReceiptSchema,
  FreePlayCompetenceBenchmarkReportSchema,
  buildFreePlayCompetenceOperatorReceipt,
  createStateDerivedFreePlayBenchmarkMind,
  evaluateFreePlayCompetenceReceipt,
  loadFreePlayCompetenceBenchmark,
  runFreePlayCompetenceBenchmark,
  type FreePlayCompetenceBenchmarkReport,
  type LoadedFreePlayCompetenceBenchmark,
} from "../src/free-play-competence.ts";
import { RealGbaRouteScenarioSchema } from "../src/real-scenario.ts";

const benchmarkPath = path.resolve(import.meta.dirname, "../fixtures/free-play/competence-benchmark-v1.json");
const clock = () => new Date("2026-08-02T12:00:00.000Z");

describe("free-play competence benchmark", () => {
  it("passes every pinned deterministic double seed with objective milestone progress", async () => {
    const benchmark = loadFreePlayCompetenceBenchmark(benchmarkPath);
    const first = await runFreePlayCompetenceBenchmark({
      benchmark,
      rootDir: await mkdtemp(path.join(tmpdir(), "free-play-competence-a-")),
      clock,
      mode: "deterministic_double",
    });
    const second = await runFreePlayCompetenceBenchmark({
      benchmark,
      rootDir: await mkdtemp(path.join(tmpdir(), "free-play-competence-b-")),
      clock,
      mode: "deterministic_double",
    });

    expect(first.result).toBe("passed");
    expect(first.runs).toHaveLength(2);
    expect(first).toEqual(second);
    for (const run of first.runs) {
      expect(run.result).toBe("passed");
      expect(run.metrics.targetReached).toBe(true);
      expect(run.metrics.milestonesReached.map((hit) => hit.milestoneId)).toContain(run.targetMilestoneId);
      expect(run.metrics.acceptedActionRate).toBeGreaterThanOrEqual(0.8);
      expect(run.metrics.distinctAcceptedActionKeys).toBeGreaterThanOrEqual(3);
      expect(run.metrics.unresolvedStallTurns).toBeNull();
      expect(run.checks.noUnresolvedStallWindow).toBe(true);
      expect(run.checks.notRepeatOnly).toBe(true);
      expect(run.checks.controlStateDerived).toBe(true);
    }
  });

  it("fails a repeat-only input consumer even when every repeated press is accepted", async () => {
    const loaded = loadFreePlayCompetenceBenchmark(benchmarkPath);
    const benchmark = {
      ...loaded,
      definition: {
        ...loaded.definition,
        defaultTurnBudget: 7,
        states: loaded.definition.states.slice(0, 1),
      },
    };
    const repeatOnlyMind: FreePlayMind = {
      decide: () =>
        Promise.resolve({
          monologue: "I will keep pressing into the same edge until the budget ends.",
          objective: "win by repeating one input",
          intent: "press left again",
          action: { kind: "button_press", button: "left", holdFrames: 16 },
        }),
    };

    const report = await runFreePlayCompetenceBenchmark({
      benchmark,
      rootDir: await mkdtemp(path.join(tmpdir(), "free-play-repeat-only-")),
      clock,
      mode: "deterministic_double",
      createMind: () => repeatOnlyMind,
    });
    const [run] = report.runs;

    expect(report.result).toBe("failed");
    expect(run?.metrics.acceptedActionRate).toBe(1);
    expect(run?.metrics.targetReached).toBe(false);
    expect(run?.metrics.longestRepeatedInputRun).toBeGreaterThanOrEqual(4);
    expect(run?.metrics.unresolvedStallTurns).toBeGreaterThanOrEqual(4);
    expect(run?.checks.targetMilestoneReached).toBe(false);
    expect(run?.checks.noUnresolvedStallWindow).toBe(false);
    expect(run?.checks.notRepeatOnly).toBe(false);
  });

  it("derives benchmark control from the current state rather than an input transcript", async () => {
    const benchmark = loadFreePlayCompetenceBenchmark(benchmarkPath);
    const state = benchmark.definition.states[0]!;
    const mind = createStateDerivedFreePlayBenchmarkMind(state);

    await expect(mind.decide(viewAt(0, 1))).resolves.toMatchObject({
      action: { kind: "walk_to", x: 3, y: 1 },
    });
    await expect(mind.decide(viewAt(3, 1))).resolves.toMatchObject({
      action: { kind: "button_press", button: "a" },
    });
    await expect(mind.decide(viewInBattle(0))).resolves.toMatchObject({
      action: { kind: "select_menu_entry", entryId: "ember" },
    });
    await expect(mind.decide(viewInBattle(1))).resolves.toMatchObject({
      action: { kind: "select_menu_entry", entryId: "ember" },
    });
  });

  it("rejects a deterministic receipt at the ROM-gated evaluator boundary", async () => {
    const benchmark = loadFreePlayCompetenceBenchmark(benchmarkPath);
    const report = await runFreePlayCompetenceBenchmark({
      benchmark,
      rootDir: await mkdtemp(path.join(tmpdir(), "free-play-receipt-run-")),
      clock,
      mode: "deterministic_double",
    });
    const root = await mkdtemp(path.join(tmpdir(), "free-play-receipt-"));
    const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
    const reportSha256 = sha256(reportBytes);
    const receipt = buildFreePlayCompetenceOperatorReceipt({
      report,
      reportSha256,
    });
    FreePlayCompetenceOperatorReceiptSchema.parse(receipt);

    await writeFile(path.join(root, "free-play-competence-report.json"), reportBytes);
    const receiptPath = path.join(root, "free-play-competence-receipt.json");
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    await expect(
      evaluateFreePlayCompetenceReceipt(receiptPath, { benchmark, expectedReport: report }),
    ).resolves.toMatchObject({
      passed: false,
      identity: { benchmarkId: "firered-free-play-competence" },
      checks: expect.arrayContaining([{ name: "ROM-gated report mode", ok: false }]),
    });
    const tamperedPath = path.join(root, "tampered-receipt.json");
    const tampered = structuredClone(receipt);
    tampered.runs[0]!.metrics.targetReached = false;
    await writeFile(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`);
    await expect(
      evaluateFreePlayCompetenceReceipt(tamperedPath, { benchmark, expectedReport: report }),
    ).resolves.toMatchObject({
      passed: false,
      checks: expect.arrayContaining([{ name: "receipt matches report", ok: false }]),
    });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain("monologue");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("button_press");
    expect(receipt.contentPolicy).toMatchObject({
      romBytesPersisted: false,
      savestateBytesPersisted: false,
      rawFramesPersisted: false,
      transcriptContentsPersisted: false,
      modelInputContentsPersisted: false,
    });
    expect(receipt.runs.every((run) => run.kind === run.identity.kind)).toBe(true);
    expect(receipt.runs.every((run) => run.identity.kind === "deterministic_double")).toBe(true);

    const linked = path.join(root, "linked-receipt.json");
    await symlink(receiptPath, linked);
    await expect(
      evaluateFreePlayCompetenceReceipt(linked, { benchmark, expectedReport: report }),
    ).rejects.toThrow(/regular file/u);
  });

  it("binds a ROM receipt to canonical pins, recomputed checks, and a fresh matching run", async () => {
    const benchmark = loadFreePlayCompetenceBenchmark(benchmarkPath);
    const report = canonicalRomReport(benchmark);
    const root = await mkdtemp(path.join(tmpdir(), "free-play-rom-receipt-"));
    const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
    const receipt = buildFreePlayCompetenceOperatorReceipt({ report, reportSha256: sha256(reportBytes) });
    await writeFile(path.join(root, "free-play-competence-report.json"), reportBytes);
    const receiptPath = path.join(root, "free-play-competence-receipt.json");
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    await expect(
      evaluateFreePlayCompetenceReceipt(receiptPath, { benchmark, expectedReport: report }),
    ).resolves.toMatchObject({
      passed: true,
      checks: expect.arrayContaining([
        { name: "canonical benchmark identity", ok: true },
        { name: "canonical ROM state set", ok: true },
        { name: "canonical ROM run derivation", ok: true },
        { name: "fresh ROM rerun matches report", ok: true },
      ]),
    });

    const fabricated = structuredClone(report);
    fabricated.runs[0]!.metrics.acceptedActions = 0;
    await expect(
      evaluateFreePlayCompetenceReceipt(receiptPath, { benchmark, expectedReport: fabricated }),
    ).resolves.toMatchObject({
      passed: false,
      checks: expect.arrayContaining([{ name: "fresh ROM rerun matches report", ok: false }]),
    });

    const forgedRoot = path.join(root, "self-consistent-forgery");
    await mkdir(forgedRoot);
    const forgedReport = structuredClone(report);
    forgedReport.runs[0]!.checkpoint.romSha256 = "b".repeat(64);
    const forgedReportBytes = `${JSON.stringify(forgedReport, null, 2)}\n`;
    const forgedReceipt = buildFreePlayCompetenceOperatorReceipt({
      report: forgedReport,
      reportSha256: sha256(forgedReportBytes),
    });
    await writeFile(path.join(forgedRoot, "free-play-competence-report.json"), forgedReportBytes);
    const forgedReceiptPath = path.join(forgedRoot, "free-play-competence-receipt.json");
    await writeFile(forgedReceiptPath, `${JSON.stringify(forgedReceipt, null, 2)}\n`);
    await expect(
      evaluateFreePlayCompetenceReceipt(forgedReceiptPath, { benchmark, expectedReport: report }),
    ).resolves.toMatchObject({
      passed: false,
      checks: expect.arrayContaining([
        { name: "receipt matches report", ok: true },
        { name: "canonical ROM run derivation", ok: false },
        { name: "fresh ROM rerun matches report", ok: false },
      ]),
    });
  });
});

function canonicalRomReport(benchmark: LoadedFreePlayCompetenceBenchmark): FreePlayCompetenceBenchmarkReport {
  const state = benchmark.definition.states.find((candidate) => candidate.kind === "rom_gated")!;
  const scenarioPath = path.resolve(path.dirname(benchmark.path), state.scenarioPath);
  const scenarioBytes = readFileSync(scenarioPath);
  const scenario = RealGbaRouteScenarioSchema.parse(JSON.parse(scenarioBytes.toString("utf8")));
  return FreePlayCompetenceBenchmarkReportSchema.parse({
    schemaVersion: 1,
    benchmarkId: benchmark.definition.benchmarkId,
    benchmarkVersion: benchmark.definition.benchmarkVersion,
    benchmarkFixtureSha256: benchmark.fixtureSha256,
    mode: "rom_gated",
    result: "passed",
    runs: [
      {
        stateId: state.stateId,
        kind: "rom_gated",
        scenarioId: scenario.scenarioId,
        scenarioVersion: scenario.scenarioVersion,
        sourceFixtureSha256: sha256(scenarioBytes),
        stateFixtureSha256: sha256(scenarioBytes),
        checkpoint: {
          coreId: scenario.coreId,
          savestateId: scenario.savestateId,
          savestateSha256: scenario.savestateSha256,
          rngSeed: scenario.rngSeed,
          romSha256: scenario.romSha256,
          coreWasmSha256: scenario.coreWasmSha256,
        },
        targetMilestoneId: state.targetMilestoneId,
        result: "passed",
        metrics: {
          turnsTaken: 1,
          turnBudget: state.turnBudget ?? benchmark.definition.defaultTurnBudget,
          acceptedActions: 1,
          acceptedActionRate: 1,
          distinctAcceptedActionKeys: 1,
          longestRepeatedInputRun: 1,
          targetReached: true,
          milestonesReached: [
            { milestoneId: state.targetMilestoneId, turn: 0, observationSha256: "a".repeat(64) },
          ],
          actionsPerMilestone: 1,
          distinctTiles: 2,
          maps: ["pallet-town/players-house-2f"],
          turnsSinceNewTile: 0,
          actionsPerNewTile: 1,
          longestStallTurns: 0,
          resolvedStallWindows: 0,
          unresolvedStallTurns: null,
          coherence: null,
        },
        checks: {
          targetMilestoneReached: true,
          allObjectiveMilestonesReached: true,
          withinTurnBudget: true,
          acceptedActionEfficient: true,
          noUnresolvedStallWindow: true,
          stallRecoveredWhenOpened: true,
          notRepeatOnly: true,
          controlStateDerived: true,
        },
      },
    ],
  });
}

function viewAt(x: number, y: number): FreePlayView {
  return viewWith([overworld({ x, y, facing: "east" })]);
}

function viewInBattle(moveCursor: number): FreePlayView {
  return viewWith([
    overworld({ x: 3, y: 1, facing: "east" }),
    {
      schemaVersion: 1,
      kind: "battle",
      observationId: "battle",
      sessionId: "s",
      characterId: "clankie",
      worldId: "gba-emulator-lab-v1",
      goalVersion: 1,
      capturedAt: "2026-08-02T12:00:00.000Z",
      frame: 2,
      data: {
        battleId: "battle-1",
        turn: 1,
        phase: "awaiting_input",
        opponent: { speciesId: "sproutlet", level: 6, currentHp: 12, maxHp: 12 },
        activePartySlot: 0,
        moveCursor,
        legalMoves: [
          { moveId: "tackle", power: 3 },
          { moveId: "ember", power: 5 },
        ],
        untrusted: true,
      },
    } as unknown as GbaEmulatorObservation,
  ]);
}

function viewWith(observations: GbaEmulatorObservation[]): FreePlayView {
  return {
    turn: 0,
    observations,
    framePng: null,
    refusedHere: [],
    stalledForTurns: null,
    notes: null,
    objective: null,
    turnsSinceSpoke: null,
    audience: null,
    interjection: null,
    history: [],
  } as FreePlayView;
}

function overworld(input: { x: number; y: number; facing: "north" | "south" | "east" | "west" }) {
  return {
    schemaVersion: 1,
    kind: "overworld",
    observationId: `overworld-${String(input.x)}-${String(input.y)}`,
    sessionId: "s",
    characterId: "clankie",
    worldId: "gba-emulator-lab-v1",
    goalVersion: 1,
    capturedAt: "2026-08-02T12:00:00.000Z",
    frame: 1,
    data: {
      position: { mapId: "verdant-path", x: input.x, y: input.y },
      facing: input.facing,
      ramStateSha256: "a".repeat(64),
    },
  } as unknown as GbaEmulatorObservation;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
