import { readFileSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { GbaEmulatorObservation } from "@clankie/interactive-environment";
import { z } from "zod";
import { type GbaAdapterScenario, type GbaCoreFactory } from "./core-seam.ts";
import { canonicalJson, sha256 } from "./core-double.ts";
import { FrozenGbaScenarioSchema, Sha256Schema } from "./contracts.ts";
import {
  runFreePlay,
  type FreePlayAction,
  type FreePlayMind,
  type FreePlaySettledTurn,
  type FreePlayView,
} from "./free-play.ts";
import { createFreePlaySession } from "./free-play-session.ts";
import { positionOf, type FreePlayProgress, type GbaPosition } from "./free-play-progress.ts";
import { RealGbaRouteScenarioSchema } from "./real-scenario.ts";

const PositionSchema = z
  .object({
    mapId: z.string().min(1).max(128),
    x: z.number().int().nonnegative().max(65_535),
    y: z.number().int().nonnegative().max(65_535),
  })
  .strict();

const MilestoneBaseSchema = z.object({ id: z.string().min(1).max(128) });

export const FreePlayCompetenceMilestoneSchema = z.discriminatedUnion("kind", [
  MilestoneBaseSchema.extend({ kind: z.literal("reached_position"), position: PositionSchema }).strict(),
  MilestoneBaseSchema.extend({ kind: z.literal("entered_map"), mapId: z.string().min(1).max(128) }).strict(),
  MilestoneBaseSchema.extend({ kind: z.literal("dialog_opened") }).strict(),
  MilestoneBaseSchema.extend({ kind: z.literal("battle_started") }).strict(),
  MilestoneBaseSchema.extend({ kind: z.literal("battle_won") }).strict(),
  MilestoneBaseSchema.extend({
    kind: z.literal("menu_observed"),
    menuId: z.string().min(1).max(128),
  }).strict(),
  MilestoneBaseSchema.extend({
    kind: z.literal("distinct_tiles"),
    count: z.number().int().positive().max(1_024),
  }).strict(),
]);
export type FreePlayCompetenceMilestone = z.infer<typeof FreePlayCompetenceMilestoneSchema>;

const PinnedStateSchema = z
  .object({
    scenarioId: z.string().min(1).max(128),
    scenarioVersion: z.number().int().positive(),
    coreId: z.string().min(1).max(128),
    savestateId: z.string().min(1).max(128),
    savestateSha256: Sha256Schema,
  })
  .strict();

export const FreePlayCompetenceStateSchema = z
  .object({
    stateId: z.string().min(1).max(128),
    kind: z.enum(["deterministic_double", "rom_gated"]),
    scenarioPath: z.string().min(1).max(512),
    pinned: PinnedStateSchema,
    rngSeed: z.number().int().nonnegative().max(4_294_967_295).optional(),
    turnBudget: z.number().int().positive().max(256).optional(),
    minimumDistinctAcceptedActions: z.number().int().positive().max(64).optional(),
    targetMilestoneId: z.string().min(1).max(128),
    milestones: z.array(FreePlayCompetenceMilestoneSchema).min(1).max(32),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.kind === "deterministic_double" && state.rngSeed === undefined) {
      context.addIssue({ code: "custom", path: ["rngSeed"], message: "deterministic states pin rngSeed" });
    }
    if (!state.milestones.some((milestone) => milestone.id === state.targetMilestoneId)) {
      context.addIssue({
        code: "custom",
        path: ["targetMilestoneId"],
        message: "targetMilestoneId must name one milestone in this state",
      });
    }
  });
export type FreePlayCompetenceState = z.infer<typeof FreePlayCompetenceStateSchema>;

export const FreePlayCompetenceBenchmarkDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    benchmarkId: z.string().min(1).max(128),
    benchmarkVersion: z.number().int().positive(),
    defaultTurnBudget: z.number().int().positive().max(256),
    stallThresholdTurns: z.number().int().positive().max(64),
    repeatedInputLimit: z.number().int().positive().max(64),
    minimumAcceptedActionRate: z.number().min(0).max(1),
    minimumDistinctAcceptedActions: z.number().int().positive().max(64),
    states: z.array(FreePlayCompetenceStateSchema).min(1).max(16),
  })
  .strict();
export type FreePlayCompetenceBenchmarkDefinition = z.infer<
  typeof FreePlayCompetenceBenchmarkDefinitionSchema
>;

const MilestoneHitSchema = z
  .object({
    milestoneId: z.string().min(1).max(128),
    turn: z.number().int().nonnegative().max(256),
    observationSha256: Sha256Schema,
  })
  .strict();
export type FreePlayCompetenceMilestoneHit = z.infer<typeof MilestoneHitSchema>;

const MetricsSchema = z
  .object({
    turnsTaken: z.number().int().nonnegative().max(256),
    turnBudget: z.number().int().positive().max(256),
    acceptedActions: z.number().int().nonnegative().max(256),
    acceptedActionRate: z.number().min(0).max(1),
    distinctAcceptedActionKeys: z.number().int().nonnegative().max(256),
    longestRepeatedInputRun: z.number().int().nonnegative().max(256),
    targetReached: z.boolean(),
    milestonesReached: z.array(MilestoneHitSchema).max(32),
    actionsPerMilestone: z.number().nullable(),
    distinctTiles: z.number().int().nonnegative().max(10_000),
    maps: z.array(z.string().min(1).max(128)).max(256),
    turnsSinceNewTile: z.number().int().nonnegative().max(256),
    actionsPerNewTile: z.number().nullable(),
    longestStallTurns: z.number().int().nonnegative().max(256),
    resolvedStallWindows: z.number().int().nonnegative().max(256),
    unresolvedStallTurns: z.number().int().nonnegative().max(256).nullable(),
    coherence: z.number().min(0).max(1).nullable(),
  })
  .strict();
export type FreePlayCompetenceMetrics = z.infer<typeof MetricsSchema>;

const ChecksSchema = z
  .object({
    targetMilestoneReached: z.boolean(),
    allObjectiveMilestonesReached: z.boolean(),
    withinTurnBudget: z.boolean(),
    acceptedActionEfficient: z.boolean(),
    noUnresolvedStallWindow: z.boolean(),
    stallRecoveredWhenOpened: z.boolean(),
    notRepeatOnly: z.boolean(),
    controlStateDerived: z.boolean(),
  })
  .strict();
export type FreePlayCompetenceChecks = z.infer<typeof ChecksSchema>;

const RunReportSchema = z
  .object({
    stateId: z.string().min(1).max(128),
    kind: z.enum(["deterministic_double", "rom_gated"]),
    scenarioId: z.string().min(1).max(128),
    scenarioVersion: z.number().int().positive(),
    sourceFixtureSha256: Sha256Schema,
    stateFixtureSha256: Sha256Schema,
    checkpoint: z
      .object({
        coreId: z.string().min(1).max(128),
        savestateId: z.string().min(1).max(128),
        savestateSha256: Sha256Schema,
        rngSeed: z.number().int().nonnegative().max(4_294_967_295),
        romSha256: Sha256Schema.optional(),
        coreWasmSha256: Sha256Schema.optional(),
      })
      .strict(),
    targetMilestoneId: z.string().min(1).max(128),
    result: z.enum(["passed", "failed"]),
    metrics: MetricsSchema,
    checks: ChecksSchema,
  })
  .strict()
  .superRefine((run, context) => {
    const passed = Object.values(run.checks).every(Boolean);
    if ((run.result === "passed") !== passed) {
      context.addIssue({ code: "custom", path: ["result"], message: "result disagrees with checks" });
    }
  });
export type FreePlayCompetenceRunReport = z.infer<typeof RunReportSchema>;

export const FreePlayCompetenceBenchmarkReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    benchmarkId: z.string().min(1).max(128),
    benchmarkVersion: z.number().int().positive(),
    benchmarkFixtureSha256: Sha256Schema,
    mode: z.enum(["deterministic_double", "rom_gated", "all"]),
    result: z.enum(["passed", "failed"]),
    runs: z.array(RunReportSchema).min(1).max(16),
  })
  .strict()
  .superRefine((report, context) => {
    const passed = report.runs.every((run) => run.result === "passed");
    if ((report.result === "passed") !== passed) {
      context.addIssue({ code: "custom", path: ["result"], message: "result disagrees with run results" });
    }
  });
export type FreePlayCompetenceBenchmarkReport = z.infer<typeof FreePlayCompetenceBenchmarkReportSchema>;

const ReceiptIdentitySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("deterministic_double"),
      stateFixtureSha256: Sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("rom_gated"),
      romSha256: Sha256Schema,
      savestateSha256: Sha256Schema,
      coreWasmSha256: Sha256Schema,
    })
    .strict(),
]);

const ContentPolicySchema = z
  .object({
    romBytesPersisted: z.literal(false),
    savestateBytesPersisted: z.literal(false),
    rawFramesPersisted: z.literal(false),
    transcriptContentsPersisted: z.literal(false),
    modelInputContentsPersisted: z.literal(false),
  })
  .strict();

export const FreePlayCompetenceOperatorReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("free_play_competence_operator_receipt"),
    benchmarkId: z.string().min(1).max(128),
    benchmarkVersion: z.number().int().positive(),
    benchmarkFixtureSha256: Sha256Schema,
    result: z.enum(["passed", "failed"]),
    runs: z
      .array(
        z
          .object({
            stateId: z.string().min(1).max(128),
            kind: z.enum(["deterministic_double", "rom_gated"]),
            result: z.enum(["passed", "failed"]),
            targetMilestoneId: z.string().min(1).max(128),
            identity: ReceiptIdentitySchema,
            metrics: MetricsSchema,
            checks: ChecksSchema,
          })
          .strict(),
      )
      .min(1)
      .max(16),
    artifacts: z.object({ reportSha256: Sha256Schema }).strict(),
    contentPolicy: ContentPolicySchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    for (const [index, run] of receipt.runs.entries()) {
      if (run.kind === run.identity.kind) continue;
      context.addIssue({
        code: "custom",
        path: ["runs", index, "identity", "kind"],
        message: "run kind and identity kind must match",
      });
    }
  });
export type FreePlayCompetenceOperatorReceipt = z.infer<typeof FreePlayCompetenceOperatorReceiptSchema>;

export interface FreePlayCompetenceReceiptEvaluation {
  schemaVersion: 1;
  passed: boolean;
  checks: { name: string; ok: boolean }[];
  identity: { benchmarkId: string; benchmarkFixtureSha256: string };
}

export interface EvaluateFreePlayCompetenceReceiptOptions {
  /** Canonical repository benchmark, loaded independently of the receipt. */
  benchmark: LoadedFreePlayCompetenceBenchmark;
  /** Fresh operator-local ROM execution produced by the evaluator process. */
  expectedReport: FreePlayCompetenceBenchmarkReport;
}

export interface LoadedFreePlayCompetenceBenchmark {
  path: string;
  fixtureSha256: string;
  definition: FreePlayCompetenceBenchmarkDefinition;
}

export function loadFreePlayCompetenceBenchmark(path: string): LoadedFreePlayCompetenceBenchmark {
  const bytes = readFileSyncCompat(path);
  return {
    path,
    fixtureSha256: sha256(bytes),
    definition: FreePlayCompetenceBenchmarkDefinitionSchema.parse(JSON.parse(bytes.toString("utf8"))),
  };
}

export interface FreePlayCompetenceCoreHandle {
  coreFactory: GbaCoreFactory;
  identity?: { romSha256: string; savestateSha256: string; coreWasmSha256: string };
}

export interface RunFreePlayCompetenceBenchmarkInput {
  benchmark: LoadedFreePlayCompetenceBenchmark;
  rootDir: string;
  mode?: "deterministic_double" | "rom_gated" | "all";
  clock?: () => Date;
  createMind?: (state: FreePlayCompetenceState) => FreePlayMind;
  controlStateDerived?: boolean;
  coreForState?: (
    state: FreePlayCompetenceState,
    scenario: GbaAdapterScenario,
  ) => Promise<FreePlayCompetenceCoreHandle | undefined> | FreePlayCompetenceCoreHandle | undefined;
}

export async function runFreePlayCompetenceBenchmark(
  input: RunFreePlayCompetenceBenchmarkInput,
): Promise<FreePlayCompetenceBenchmarkReport> {
  const mode = input.mode ?? "deterministic_double";
  const states = input.benchmark.definition.states.filter((state) => mode === "all" || state.kind === mode);
  if (states.length === 0) throw new Error(`free_play_competence_no_states:${mode}`);
  const runs: FreePlayCompetenceRunReport[] = [];
  for (const state of states) runs.push(await runState(input, state));
  return FreePlayCompetenceBenchmarkReportSchema.parse({
    schemaVersion: 1,
    benchmarkId: input.benchmark.definition.benchmarkId,
    benchmarkVersion: input.benchmark.definition.benchmarkVersion,
    benchmarkFixtureSha256: input.benchmark.fixtureSha256,
    mode,
    result: runs.every((run) => run.result === "passed") ? "passed" : "failed",
    runs,
  });
}

export function createStateDerivedFreePlayBenchmarkMind(state: FreePlayCompetenceState): FreePlayMind {
  const target = targetPositionForState(state);
  return {
    decide: (view) => Promise.resolve(decideStateDerivedAction(state, target, view)),
  };
}

export function decideStateDerivedAction(
  state: FreePlayCompetenceState,
  target: GbaPosition | null,
  view: FreePlayView,
): { monologue: string; objective: string; intent: string; action: FreePlayAction } {
  const battle = firstObservation(view.observations, "battle");
  if (battle !== null) {
    const phase = (battle as { data?: { phase?: string } }).data?.phase;
    if (phase === "won")
      return decision("confirm the won battle", "battle is won", { kind: "frame_advance", frames: 1 });
    if (phase === "resolving")
      return decision("advance the battle text", "advance battle text", { kind: "advance_dialog" });
    const legalMoves =
      (battle as { data?: { legalMoves?: { moveId?: string; power?: number }[] } }).data?.legalMoves ?? [];
    const best = legalMoves.reduce<{ moveId: string; power: number } | null>((winner, move) => {
      if (typeof move.moveId !== "string" || typeof move.power !== "number") return winner;
      return winner === null || move.power > winner.power
        ? { moveId: move.moveId, power: move.power }
        : winner;
    }, null);
    if (best !== null) {
      return decision("choose the strongest decoded legal move", `select ${best.moveId}`, {
        kind: "select_menu_entry",
        entryId: best.moveId,
      });
    }
    return decision("wait for a decoded battle choice", "advance frames", {
      kind: "frame_advance",
      frames: 16,
    });
  }

  if (firstObservation(view.observations, "dialog") !== null) {
    return decision("read the open conversation to the next decision point", "advance dialog", {
      kind: "advance_dialog",
    });
  }

  const position = positionOf(view.observations);
  if (target !== null && position !== null) {
    if (samePosition(position, target)) {
      return decision("the target tile is reached; interact with what is there", "press A at target", {
        kind: "button_press",
        button: "a",
        holdFrames: 16,
      });
    }
    return decision(`walk from observed position toward ${state.targetMilestoneId}`, "walk to target", {
      kind: "walk_to",
      x: target.x,
      y: target.y,
    });
  }

  return decision("state is readable but no route target is available", "advance frames", {
    kind: "frame_advance",
    frames: 16,
  });
}

export interface BuildFreePlayCompetenceOperatorReceiptInput {
  report: FreePlayCompetenceBenchmarkReport;
  reportSha256: string;
}

export function buildFreePlayCompetenceOperatorReceipt(
  input: BuildFreePlayCompetenceOperatorReceiptInput,
): FreePlayCompetenceOperatorReceipt {
  return FreePlayCompetenceOperatorReceiptSchema.parse({
    schemaVersion: 1,
    kind: "free_play_competence_operator_receipt",
    benchmarkId: input.report.benchmarkId,
    benchmarkVersion: input.report.benchmarkVersion,
    benchmarkFixtureSha256: input.report.benchmarkFixtureSha256,
    result: input.report.result,
    runs: input.report.runs.map((run) => ({
      stateId: run.stateId,
      kind: run.kind,
      result: run.result,
      targetMilestoneId: run.targetMilestoneId,
      identity:
        run.kind === "deterministic_double"
          ? { kind: "deterministic_double", stateFixtureSha256: run.stateFixtureSha256 }
          : {
              kind: "rom_gated",
              romSha256: requiredCheckpointHash(run, "romSha256"),
              savestateSha256: run.checkpoint.savestateSha256,
              coreWasmSha256: requiredCheckpointHash(run, "coreWasmSha256"),
            },
      metrics: run.metrics,
      checks: run.checks,
    })),
    artifacts: { reportSha256: input.reportSha256 },
    contentPolicy: {
      romBytesPersisted: false,
      savestateBytesPersisted: false,
      rawFramesPersisted: false,
      transcriptContentsPersisted: false,
      modelInputContentsPersisted: false,
    },
  });
}

export async function evaluateFreePlayCompetenceReceipt(
  path: string,
  options: EvaluateFreePlayCompetenceReceiptOptions,
): Promise<FreePlayCompetenceReceiptEvaluation> {
  const receiptBytes = await readRegularFile(path, 256 * 1024);
  const receipt = FreePlayCompetenceOperatorReceiptSchema.parse(JSON.parse(receiptBytes.toString("utf8")));
  const reportBytes = await readRegularFile(
    join(dirname(path), "free-play-competence-report.json"),
    2 * 1024 * 1024,
  );
  const report = FreePlayCompetenceBenchmarkReportSchema.parse(JSON.parse(reportBytes.toString("utf8")));
  const expectedReceipt = buildFreePlayCompetenceOperatorReceipt({
    report,
    reportSha256: sha256(reportBytes),
  });
  const canonicalChecks = canonicalRomReportChecks(report, options.benchmark);
  const freshReport = FreePlayCompetenceBenchmarkReportSchema.parse(options.expectedReport);
  const checks = [
    { name: "report artifact hash", ok: sha256(reportBytes) === receipt.artifacts.reportSha256 },
    {
      name: "receipt matches report",
      ok: canonicalJson(receipt) === canonicalJson(expectedReceipt),
    },
    ...canonicalChecks,
    {
      name: "fresh ROM rerun matches report",
      ok: canonicalJson(report) === canonicalJson(freshReport),
    },
    { name: "benchmark passed", ok: receipt.result === "passed" },
    { name: "all runs passed", ok: receipt.runs.every((run) => run.result === "passed") },
    {
      name: "all target milestones reached",
      ok: receipt.runs.every((run) => run.metrics.targetReached && run.checks.targetMilestoneReached),
    },
    {
      name: "no unresolved stall windows",
      ok: receipt.runs.every(
        (run) => run.metrics.unresolvedStallTurns === null && run.checks.noUnresolvedStallWindow,
      ),
    },
    {
      name: "content-free receipt policy",
      ok: Object.values(receipt.contentPolicy).every((value) => value === false),
    },
  ];
  return {
    schemaVersion: 1,
    passed: checks.every((check) => check.ok),
    checks,
    identity: {
      benchmarkId: receipt.benchmarkId,
      benchmarkFixtureSha256: receipt.benchmarkFixtureSha256,
    },
  };
}

function canonicalRomReportChecks(
  report: FreePlayCompetenceBenchmarkReport,
  benchmark: LoadedFreePlayCompetenceBenchmark,
): { name: string; ok: boolean }[] {
  const states = benchmark.definition.states.filter((state) => state.kind === "rom_gated");
  const expectedStateIds = states.map((state) => state.stateId).sort();
  const actualStateIds = report.runs.map((run) => run.stateId).sort();
  const stateById = new Map(states.map((state) => [state.stateId, state]));
  const runChecks = report.runs.map((run) => {
    const state = stateById.get(run.stateId);
    if (state === undefined) return false;
    const loaded = loadScenarioForState(benchmark, state);
    const recomputed = checksForRun({
      definition: benchmark.definition,
      state,
      metrics: run.metrics,
      controlStateDerived: true,
    });
    const reachedIds = run.metrics.milestonesReached.map((hit) => hit.milestoneId);
    const uniqueReachedIds = new Set(reachedIds);
    const canonicalMilestoneIds = new Set(state.milestones.map((milestone) => milestone.id));
    const expectedAcceptedRate =
      run.metrics.turnsTaken === 0 ? 0 : run.metrics.acceptedActions / run.metrics.turnsTaken;
    const expectedActionsPerMilestone =
      reachedIds.length === 0 ? null : run.metrics.acceptedActions / reachedIds.length;
    return (
      run.kind === "rom_gated" &&
      run.scenarioId === loaded.ids.scenarioId &&
      run.scenarioVersion === loaded.ids.scenarioVersion &&
      run.sourceFixtureSha256 === loaded.sourceFixtureSha256 &&
      run.stateFixtureSha256 === loaded.stateFixtureSha256 &&
      run.checkpoint.coreId === loaded.ids.coreId &&
      run.checkpoint.savestateId === loaded.ids.savestateId &&
      run.checkpoint.savestateSha256 === loaded.ids.savestateSha256 &&
      run.checkpoint.rngSeed === loaded.ids.rngSeed &&
      run.checkpoint.romSha256 === loaded.ids.romSha256 &&
      run.checkpoint.coreWasmSha256 === loaded.ids.coreWasmSha256 &&
      run.targetMilestoneId === state.targetMilestoneId &&
      run.metrics.turnBudget === (state.turnBudget ?? benchmark.definition.defaultTurnBudget) &&
      run.metrics.acceptedActions <= run.metrics.turnsTaken &&
      run.metrics.acceptedActionRate === expectedAcceptedRate &&
      run.metrics.distinctAcceptedActionKeys <= run.metrics.acceptedActions &&
      run.metrics.longestRepeatedInputRun <= run.metrics.acceptedActions &&
      run.metrics.targetReached === reachedIds.includes(state.targetMilestoneId) &&
      uniqueReachedIds.size === reachedIds.length &&
      reachedIds.every((id) => canonicalMilestoneIds.has(id)) &&
      run.metrics.milestonesReached.every((hit) => hit.turn < run.metrics.turnsTaken) &&
      run.metrics.actionsPerMilestone === expectedActionsPerMilestone &&
      canonicalJson(run.checks) === canonicalJson(recomputed) &&
      run.result === (Object.values(recomputed).every(Boolean) ? "passed" : "failed")
    );
  });
  return [
    {
      name: "canonical benchmark identity",
      ok:
        report.benchmarkId === benchmark.definition.benchmarkId &&
        report.benchmarkVersion === benchmark.definition.benchmarkVersion &&
        report.benchmarkFixtureSha256 === benchmark.fixtureSha256,
    },
    { name: "ROM-gated report mode", ok: report.mode === "rom_gated" },
    {
      name: "canonical ROM state set",
      ok:
        states.length > 0 &&
        expectedStateIds.length === actualStateIds.length &&
        expectedStateIds.every((stateId, index) => stateId === actualStateIds[index]),
    },
    {
      name: "canonical ROM run derivation",
      ok: runChecks.length === states.length && runChecks.every(Boolean),
    },
  ];
}

async function runState(
  input: RunFreePlayCompetenceBenchmarkInput,
  state: FreePlayCompetenceState,
): Promise<FreePlayCompetenceRunReport> {
  const loaded = loadScenarioForState(input.benchmark, state);
  const core = await input.coreForState?.(state, loaded.scenario);
  if (state.kind === "rom_gated" && core === undefined) {
    throw new Error(`free_play_competence_rom_core_required:${state.stateId}`);
  }
  if (state.kind === "rom_gated" && core?.identity !== undefined) {
    assertCoreIdentity(state, loaded.ids, core.identity);
  }
  const tracker = new CompetenceTracker(state, input.benchmark.definition);
  const session = await createFreePlaySession({
    rootDir: input.rootDir,
    scenario: loaded.scenario,
    fixtureSha256: loaded.stateFixtureSha256,
    ...(core?.coreFactory === undefined ? {} : { coreFactory: core.coreFactory }),
    acquireBody: false,
    runId: `competence-${state.stateId}`,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  const mind = input.createMind?.(state) ?? createStateDerivedFreePlayBenchmarkMind(state);
  try {
    const result = await runFreePlay({
      io: session.io,
      mind,
      turns: state.turnBudget ?? input.benchmark.definition.defaultTurnBudget,
      shouldStop: () => tracker.targetReached,
      onSettledTurn: (event) => tracker.record(event),
    });
    const metrics = tracker.metrics(result.progress, result.accepted, result.turns.length, result.coherence);
    const checks = checksForRun({
      definition: input.benchmark.definition,
      state,
      metrics,
      controlStateDerived: input.controlStateDerived ?? input.createMind === undefined,
    });
    return RunReportSchema.parse({
      stateId: state.stateId,
      kind: state.kind,
      scenarioId: loaded.ids.scenarioId,
      scenarioVersion: loaded.ids.scenarioVersion,
      sourceFixtureSha256: loaded.sourceFixtureSha256,
      stateFixtureSha256: loaded.stateFixtureSha256,
      checkpoint: {
        coreId: loaded.ids.coreId,
        savestateId: loaded.ids.savestateId,
        savestateSha256: loaded.ids.savestateSha256,
        rngSeed: loaded.ids.rngSeed,
        ...(loaded.ids.romSha256 === undefined ? {} : { romSha256: loaded.ids.romSha256 }),
        ...(loaded.ids.coreWasmSha256 === undefined ? {} : { coreWasmSha256: loaded.ids.coreWasmSha256 }),
      },
      targetMilestoneId: state.targetMilestoneId,
      result: Object.values(checks).every(Boolean) ? "passed" : "failed",
      metrics,
      checks,
    });
  } finally {
    session.close();
  }
}

function loadScenarioForState(
  benchmark: LoadedFreePlayCompetenceBenchmark,
  state: FreePlayCompetenceState,
): {
  scenario: GbaAdapterScenario;
  sourceFixtureSha256: string;
  stateFixtureSha256: string;
  ids: {
    scenarioId: string;
    scenarioVersion: number;
    coreId: string;
    savestateId: string;
    savestateSha256: string;
    rngSeed: number;
    romSha256?: string;
    coreWasmSha256?: string;
  };
} {
  const scenarioPath = resolve(dirname(benchmark.path), state.scenarioPath);
  const bytes = readFileSyncCompat(scenarioPath);
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  const sourceFixtureSha256 = sha256(bytes);
  if (state.kind === "deterministic_double") {
    const base = FrozenGbaScenarioSchema.parse(parsed);
    const scenario = FrozenGbaScenarioSchema.parse({ ...base, rngSeed: state.rngSeed });
    assertPins(state, scenario);
    return {
      scenario: scenario as GbaAdapterScenario,
      sourceFixtureSha256,
      stateFixtureSha256: sha256(canonicalJson(scenario)),
      ids: {
        scenarioId: scenario.scenarioId,
        scenarioVersion: scenario.scenarioVersion,
        coreId: scenario.coreId,
        savestateId: scenario.savestateId,
        savestateSha256: scenario.savestateSha256,
        rngSeed: scenario.rngSeed,
      },
    };
  }
  const scenario = RealGbaRouteScenarioSchema.parse(parsed);
  assertPins(state, scenario);
  return {
    scenario: scenario as GbaAdapterScenario,
    sourceFixtureSha256,
    stateFixtureSha256: sourceFixtureSha256,
    ids: {
      scenarioId: scenario.scenarioId,
      scenarioVersion: scenario.scenarioVersion,
      coreId: scenario.coreId,
      savestateId: scenario.savestateId,
      savestateSha256: scenario.savestateSha256,
      rngSeed: scenario.rngSeed,
      romSha256: scenario.romSha256,
      coreWasmSha256: scenario.coreWasmSha256,
    },
  };
}

function assertPins(
  state: FreePlayCompetenceState,
  scenario: {
    scenarioId: string;
    scenarioVersion: number;
    coreId: string;
    savestateId: string;
    savestateSha256: string;
  },
): void {
  const expected = state.pinned;
  if (
    expected.scenarioId !== scenario.scenarioId ||
    expected.scenarioVersion !== scenario.scenarioVersion ||
    expected.coreId !== scenario.coreId ||
    expected.savestateId !== scenario.savestateId ||
    expected.savestateSha256 !== scenario.savestateSha256
  ) {
    throw new Error(`free_play_competence_state_pin_mismatch:${state.stateId}`);
  }
}

function assertCoreIdentity(
  state: FreePlayCompetenceState,
  expected: { romSha256?: string; savestateSha256: string; coreWasmSha256?: string },
  actual: { romSha256: string; savestateSha256: string; coreWasmSha256: string },
): void {
  if (
    actual.romSha256 !== expected.romSha256 ||
    actual.savestateSha256 !== expected.savestateSha256 ||
    actual.coreWasmSha256 !== expected.coreWasmSha256
  ) {
    throw new Error(`free_play_competence_core_identity_mismatch:${state.stateId}`);
  }
}

function checksForRun(input: {
  definition: FreePlayCompetenceBenchmarkDefinition;
  state: FreePlayCompetenceState;
  metrics: FreePlayCompetenceMetrics;
  controlStateDerived: boolean;
}): FreePlayCompetenceChecks {
  const allMilestones = input.state.milestones.every((milestone) =>
    input.metrics.milestonesReached.some((hit) => hit.milestoneId === milestone.id),
  );
  return ChecksSchema.parse({
    targetMilestoneReached: input.metrics.targetReached,
    allObjectiveMilestonesReached: allMilestones,
    withinTurnBudget: input.metrics.turnsTaken <= input.metrics.turnBudget,
    acceptedActionEfficient: input.metrics.acceptedActionRate >= input.definition.minimumAcceptedActionRate,
    noUnresolvedStallWindow: input.metrics.unresolvedStallTurns === null,
    stallRecoveredWhenOpened: input.metrics.unresolvedStallTurns === null,
    notRepeatOnly:
      input.metrics.targetReached &&
      input.metrics.distinctAcceptedActionKeys >=
        (input.state.minimumDistinctAcceptedActions ?? input.definition.minimumDistinctAcceptedActions) &&
      input.metrics.longestRepeatedInputRun < input.definition.repeatedInputLimit,
    controlStateDerived: input.controlStateDerived,
  });
}

class CompetenceTracker {
  private readonly state: FreePlayCompetenceState;
  private readonly definition: FreePlayCompetenceBenchmarkDefinition;
  private readonly reached = new Map<string, FreePlayCompetenceMilestoneHit>();
  private readonly acceptedActionKeys = new Set<string>();
  private previousAcceptedActionKey: string | null = null;
  private repeatedRun = 0;
  private longestRepeatedRun = 0;
  private longestStall = 0;
  private stallOpenAtTurn: number | null = null;
  private resolvedStalls = 0;
  private unresolvedStall: number | null = null;

  public constructor(state: FreePlayCompetenceState, definition: FreePlayCompetenceBenchmarkDefinition) {
    this.state = state;
    this.definition = definition;
  }

  public get targetReached(): boolean {
    return this.reached.has(this.state.targetMilestoneId);
  }

  public record(event: FreePlaySettledTurn): void {
    const turn = event.turn.turn;
    const newlyReached = this.recordMilestones(turn, event.after, event.progress);
    if (event.turn.outcome === "accepted" && event.turn.action !== null)
      this.recordAcceptedAction(event.turn.action);
    this.longestStall = Math.max(this.longestStall, event.progress.turnsSinceNewTile);
    const madeProgress = event.progress.turnsSinceNewTile === 0 || newlyReached;
    if (
      event.progress.turnsSinceNewTile >= this.definition.stallThresholdTurns &&
      this.stallOpenAtTurn === null
    ) {
      this.stallOpenAtTurn = turn;
    }
    if (madeProgress && this.stallOpenAtTurn !== null) {
      this.resolvedStalls += 1;
      this.stallOpenAtTurn = null;
    }
    this.unresolvedStall =
      this.stallOpenAtTurn === null
        ? null
        : turn - this.stallOpenAtTurn + this.definition.stallThresholdTurns;
  }

  public metrics(
    progress: FreePlayProgress,
    accepted: number,
    turnsTaken: number,
    coherence: number | null,
  ): FreePlayCompetenceMetrics {
    return MetricsSchema.parse({
      turnsTaken,
      turnBudget: this.state.turnBudget ?? this.definition.defaultTurnBudget,
      acceptedActions: accepted,
      acceptedActionRate: turnsTaken === 0 ? 0 : accepted / turnsTaken,
      distinctAcceptedActionKeys: this.acceptedActionKeys.size,
      longestRepeatedInputRun: this.longestRepeatedRun,
      targetReached: this.targetReached,
      milestonesReached: [...this.reached.values()].sort((left, right) => left.turn - right.turn),
      actionsPerMilestone: this.reached.size === 0 ? null : accepted / this.reached.size,
      distinctTiles: progress.distinctTiles,
      maps: progress.maps,
      turnsSinceNewTile: progress.turnsSinceNewTile,
      actionsPerNewTile: progress.actionsPerNewTile,
      longestStallTurns: this.longestStall,
      resolvedStallWindows: this.resolvedStalls,
      unresolvedStallTurns: this.unresolvedStall,
      coherence,
    });
  }

  private recordAcceptedAction(action: FreePlayAction): void {
    const key = actionKey(action);
    this.acceptedActionKeys.add(key);
    if (key === this.previousAcceptedActionKey) {
      this.repeatedRun += 1;
    } else {
      this.previousAcceptedActionKey = key;
      this.repeatedRun = 1;
    }
    this.longestRepeatedRun = Math.max(this.longestRepeatedRun, this.repeatedRun);
  }

  private recordMilestones(
    turn: number,
    observations: readonly GbaEmulatorObservation[],
    progress: FreePlayProgress,
  ): boolean {
    let changed = false;
    for (const milestone of this.state.milestones) {
      if (this.reached.has(milestone.id) || !milestoneReached(milestone, observations, progress)) continue;
      this.reached.set(
        milestone.id,
        MilestoneHitSchema.parse({
          milestoneId: milestone.id,
          turn,
          observationSha256: sha256(canonicalJson(observations)),
        }),
      );
      changed = true;
    }
    return changed;
  }
}

function milestoneReached(
  milestone: FreePlayCompetenceMilestone,
  observations: readonly GbaEmulatorObservation[],
  progress: FreePlayProgress,
): boolean {
  if (milestone.kind === "distinct_tiles") return progress.distinctTiles >= milestone.count;
  if (milestone.kind === "entered_map") return progress.maps.includes(milestone.mapId);
  if (milestone.kind === "reached_position") {
    const position = positionOf(observations);
    return position !== null && samePosition(position, milestone.position);
  }
  if (milestone.kind === "dialog_opened") return firstObservation(observations, "dialog") !== null;
  if (milestone.kind === "menu_observed") {
    const menu = firstObservation(observations, "menu") as { data?: { menuId?: string } } | null;
    return menu?.data?.menuId === milestone.menuId;
  }
  const battle = firstObservation(observations, "battle") as { data?: { phase?: string } } | null;
  if (milestone.kind === "battle_started") return battle !== null;
  return battle?.data?.phase === "won";
}

function targetPositionForState(state: FreePlayCompetenceState): GbaPosition | null {
  const reached = state.milestones.find((milestone) => milestone.kind === "reached_position");
  return reached?.kind === "reached_position" ? reached.position : null;
}

function samePosition(left: GbaPosition, right: GbaPosition): boolean {
  return left.mapId === right.mapId && left.x === right.x && left.y === right.y;
}

function firstObservation(
  observations: readonly GbaEmulatorObservation[],
  kind: GbaEmulatorObservation["kind"],
): GbaEmulatorObservation | null {
  return observations.find((observation) => observation.kind === kind) ?? null;
}

function decision(
  monologue: string,
  intent: string,
  action: FreePlayAction,
): { monologue: string; objective: string; intent: string; action: FreePlayAction } {
  return {
    monologue,
    objective: "reach the benchmark target milestone from observed state",
    intent,
    action,
  };
}

function actionKey(action: FreePlayAction): string {
  return sha256(canonicalJson(action));
}

async function readRegularFile(path: string, maximumBytes: number): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Free-play competence evidence must be a regular file: ${path}`);
  }
  if (metadata.size === 0 || metadata.size > maximumBytes) {
    throw new Error(`Free-play competence evidence has an invalid size: ${path}`);
  }
  return readFile(path);
}

function readFileSyncCompat(path: string): Buffer {
  return readFileSync(path);
}

function requiredCheckpointHash(
  run: FreePlayCompetenceRunReport,
  key: "romSha256" | "coreWasmSha256",
): string {
  const value = run.checkpoint[key];
  if (value === undefined) throw new Error(`free_play_competence_missing_${key}:${run.stateId}`);
  return value;
}
