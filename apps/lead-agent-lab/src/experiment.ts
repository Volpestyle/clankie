import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { reportToMarkdown, type LeadEvaluationReport } from "@clankie/evals";
import { JsonlEventStore } from "@clankie/event-store";
import type { DomainEvent } from "@clankie/protocol";
import { runSingleAgentBaseline } from "./baseline.ts";
import { runSelfBuildLab, SELF_BUILD_SCENARIO, repoRoot, type SimulatedLeadArm } from "./lab.ts";

interface ExperimentSpec {
  id: string;
  arms: Array<Record<string, unknown>>;
  scenarios: string[];
  repetitions: number;
  metrics: string[];
  promotion: Record<string, unknown>;
}

type ExecutedArmId = "single-worker" | SimulatedLeadArm;

export interface ArmRepetitionOutcome {
  seed: string;
  doctrineHash: string;
  report: LeadEvaluationReport;
  criticalFailures: string[];
  groundTruthPassed?: boolean;
  implementationWorkerId?: string;
  verificationWorkerId?: string;
  verificationIndependent: boolean;
  workerHarnesses: string[];
}

export interface ArmAggregate {
  repetitions: number;
  score: {
    mean: number;
    spread: number;
    min: number;
    max: number;
    standardDeviation: number;
  };
  passedCount: number;
  passedRate: number;
  verificationIndependentCount: number;
  criticalFailureCount: number;
  criticalFailures: Record<string, number>;
}

export interface ArmOutcome {
  id: string;
  role: string;
  executed: boolean;
  reason?: string;
  /** First repetition, retained for backward compatibility with the single-run report. */
  report?: LeadEvaluationReport;
  criticalFailures?: string[];
  groundTruthPassed?: boolean;
  repetitions?: ArmRepetitionOutcome[];
  aggregate?: ArmAggregate;
}

export interface CriterionDelta {
  id: string;
  label: string;
  baseline: "pass" | "fail";
  treatment: "pass" | "fail";
  changed: boolean;
  baselinePassRate: number;
  treatmentPassRate: number;
}

export interface ExperimentComparisonReport {
  version: "1";
  experimentId: string;
  generatedAt: string;
  doctrineHash: string;
  scenario: { id: string; fixture: string };
  seed: { count: number; values: string[]; note: string };
  evaluator: { digestSha256: string; threshold: number };
  arms: ArmOutcome[];
  comparison: {
    baselineArm: string;
    treatmentArm: string;
    baselineScore: number;
    treatmentScore: number;
    scoreDelta: number;
    baselinePassed: boolean;
    treatmentPassed: boolean;
    treatmentBeatsBaseline: boolean;
    baselineCriticalFailures: string[];
    treatmentCriticalFailures: string[];
    perCriterion: CriterionDelta[];
  };
  scenariosDeclaredButUnimplemented: string[];
  promotion: Record<string, unknown> & { note: string };
}

export interface RunExperimentOptions {
  outputDirectory?: string;
  generatedAt?: string;
  repetitions?: number;
  seeds?: string[];
}

export interface ExperimentRun {
  report: ExperimentComparisonReport;
  artifactDirectory?: string;
  /** First repetition per arm, retained for existing callers. */
  armEvents: Record<string, DomainEvent[]>;
  armRepetitions: Record<string, Array<{ seed: string; events: DomainEvent[] }>>;
}

export interface DoctrineRunIdentity {
  armId: string;
  seed: string;
  doctrineHash: string;
}

interface ExecutedArmRun extends DoctrineRunIdentity {
  armId: ExecutedArmId;
  report: LeadEvaluationReport;
  events: DomainEvent[];
  groundTruthPassed?: boolean;
  implementationWorkerId?: string;
  verificationWorkerId?: string;
  workerHarnesses: string[];
}

async function evaluatorDigest(): Promise<string> {
  const source = await readFile(join(repoRoot, "packages/evals/src/index.ts"), "utf8");
  return createHash("sha256").update(source).digest("hex");
}

function passRate(reports: readonly LeadEvaluationReport[], criterionId: string): number {
  const passing = reports.filter(
    (report) => report.criteria.find((criterion) => criterion.id === criterionId)?.passed,
  ).length;
  return passing / reports.length;
}

function aggregateRuns(runs: readonly ExecutedArmRun[]): ArmAggregate {
  if (runs.length === 0) throw new Error("Cannot aggregate an arm with no repetitions");
  const scores = runs.map((run) => run.report.overallScore);
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const variance = scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / scores.length;
  const criticalFailures: Record<string, number> = {};
  for (const failure of runs.flatMap((run) => run.report.criticalFailures)) {
    criticalFailures[failure] = (criticalFailures[failure] ?? 0) + 1;
  }
  return {
    repetitions: runs.length,
    score: {
      mean,
      spread: max - min,
      min,
      max,
      standardDeviation: Math.sqrt(variance),
    },
    passedCount: runs.filter((run) => run.report.passed).length,
    passedRate: runs.filter((run) => run.report.passed).length / runs.length,
    verificationIndependentCount: runs.filter(
      (run) =>
        Boolean(run.implementationWorkerId) &&
        Boolean(run.verificationWorkerId) &&
        run.implementationWorkerId !== run.verificationWorkerId,
    ).length,
    criticalFailureCount: Object.values(criticalFailures).reduce((sum, count) => sum + count, 0),
    criticalFailures,
  };
}

/** Refuses comparison before any score or verdict can combine unlike doctrine profiles. */
export function assertComparableDoctrineHashes(runs: readonly DoctrineRunIdentity[]): string {
  if (runs.length === 0) throw new Error("Cannot compare experiment arms without executed runs");
  const byHash = new Map<string, string[]>();
  for (const run of runs) {
    if (!run.doctrineHash.trim()) {
      throw new Error(`Run ${run.armId}@${run.seed} has no doctrine hash; comparison refused.`);
    }
    const identities = byHash.get(run.doctrineHash) ?? [];
    identities.push(`${run.armId}@${run.seed}`);
    byHash.set(run.doctrineHash, identities);
  }
  if (byHash.size !== 1) {
    const details = [...byHash.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([hash, identities]) => `${hash}=[${identities.sort().join(", ")}]`)
      .join("; ");
    throw new Error(`Doctrine hash mismatch; cross-arm comparison refused: ${details}`);
  }
  return [...byHash.keys()][0] as string;
}

function resolveSeeds(spec: ExperimentSpec, options: RunExperimentOptions): string[] {
  const count = options.repetitions ?? options.seeds?.length ?? 1;
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`Experiment repetitions must be a positive integer; received ${count}`);
  }
  const seeds =
    options.seeds?.map((seed) => seed.trim()) ??
    Array.from(
      { length: count },
      (_, index) => `${spec.id}:${SELF_BUILD_SCENARIO.scenarioId}:${String(index + 1).padStart(4, "0")}`,
    );
  if (seeds.length !== count) {
    throw new Error(`Expected ${count} seeds for ${count} repetitions; received ${seeds.length}`);
  }
  if (seeds.some((seed) => seed.length === 0)) throw new Error("Experiment seeds must not be empty");
  if (new Set(seeds).size !== seeds.length) {
    throw new Error("Experiment repetitions require distinct seeds; duplicate seed supplied");
  }
  return seeds;
}

function repetitionOutcome(run: ExecutedArmRun): ArmRepetitionOutcome {
  const verificationIndependent =
    Boolean(run.implementationWorkerId) &&
    Boolean(run.verificationWorkerId) &&
    run.implementationWorkerId !== run.verificationWorkerId;
  return {
    seed: run.seed,
    doctrineHash: run.doctrineHash,
    report: run.report,
    criticalFailures: run.report.criticalFailures,
    ...(run.groundTruthPassed === undefined ? {} : { groundTruthPassed: run.groundTruthPassed }),
    ...(run.implementationWorkerId ? { implementationWorkerId: run.implementationWorkerId } : {}),
    ...(run.verificationWorkerId ? { verificationWorkerId: run.verificationWorkerId } : {}),
    verificationIndependent,
    workerHarnesses: run.workerHarnesses,
  };
}

function eventHarnesses(events: readonly DomainEvent[]): string[] {
  return [
    ...new Set(
      events
        .filter((event) => event.type === "worker.started")
        .map((event) => event.data.harness)
        .filter((harness): harness is string => typeof harness === "string"),
    ),
  ].sort();
}

async function runRepetition(seed: string, generatedAt: string): Promise<ExecutedArmRun[]> {
  const [baseline, homogeneous, treatment, ablation] = await Promise.all([
    runSingleAgentBaseline({ generatedAt, seed }),
    runSelfBuildLab({ generatedAt, seed, arm: "homogeneous-lead" }),
    runSelfBuildLab({ generatedAt, seed, arm: "heterogeneous-lead" }),
    runSelfBuildLab({ generatedAt, seed, arm: "no-independent-verifier" }),
  ]);
  return [
    {
      armId: "single-worker",
      seed,
      doctrineHash: baseline.profileHash,
      report: baseline.report,
      events: baseline.events,
      groundTruthPassed: baseline.groundTruthPassed,
      ...(baseline.implementationWorkerId ? { implementationWorkerId: baseline.implementationWorkerId } : {}),
      workerHarnesses: eventHarnesses(baseline.events),
    },
    {
      armId: homogeneous.armId,
      seed,
      doctrineHash: homogeneous.profileHash,
      report: homogeneous.report,
      events: homogeneous.events,
      ...(homogeneous.implementationWorkerId
        ? { implementationWorkerId: homogeneous.implementationWorkerId }
        : {}),
      ...(homogeneous.verificationWorkerId ? { verificationWorkerId: homogeneous.verificationWorkerId } : {}),
      workerHarnesses: homogeneous.workerHarnesses,
    },
    {
      armId: treatment.armId,
      seed,
      doctrineHash: treatment.profileHash,
      report: treatment.report,
      events: treatment.events,
      ...(treatment.implementationWorkerId
        ? { implementationWorkerId: treatment.implementationWorkerId }
        : {}),
      ...(treatment.verificationWorkerId ? { verificationWorkerId: treatment.verificationWorkerId } : {}),
      workerHarnesses: treatment.workerHarnesses,
    },
    {
      armId: ablation.armId,
      seed,
      doctrineHash: ablation.profileHash,
      report: ablation.report,
      events: ablation.events,
      ...(ablation.implementationWorkerId ? { implementationWorkerId: ablation.implementationWorkerId } : {}),
      ...(ablation.verificationWorkerId ? { verificationWorkerId: ablation.verificationWorkerId } : {}),
      workerHarnesses: ablation.workerHarnesses,
    },
  ];
}

function executedOutcome(id: ExecutedArmId, role: string, runs: readonly ExecutedArmRun[]): ArmOutcome {
  const first = runs[0];
  if (!first) throw new Error(`No executed repetitions found for arm ${id}`);
  const aggregate = aggregateRuns(runs);
  return {
    id,
    role,
    executed: true,
    report: first.report,
    criticalFailures: Object.keys(aggregate.criticalFailures).sort(),
    ...(first.groundTruthPassed === undefined ? {} : { groundTruthPassed: first.groundTruthPassed }),
    repetitions: runs.map(repetitionOutcome),
    aggregate,
  };
}

/** Executes all declared offline arms over identical, distinct scenario seeds. */
export async function runExperiment(options: RunExperimentOptions = {}): Promise<ExperimentRun> {
  const specPath = join(repoRoot, "evals/experiments/lead-vs-single.yaml");
  const spec = parseYaml(await readFile(specPath, "utf8")) as ExperimentSpec;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const seeds = resolveSeeds(spec, options);
  const executedRuns: ExecutedArmRun[] = [];
  for (const seed of seeds) executedRuns.push(...(await runRepetition(seed, generatedAt)));

  const doctrineHash = assertComparableDoctrineHashes(executedRuns);
  const runsByArm = new Map<ExecutedArmId, ExecutedArmRun[]>();
  for (const run of executedRuns) {
    const runs = runsByArm.get(run.armId) ?? [];
    runs.push(run);
    runsByArm.set(run.armId, runs);
  }

  const armRole = new Map<string, string>([
    ["single-worker", "baseline (Arm A · unconstrained single agent)"],
    ["heterogeneous-lead", "treatment (Arm C · heterogeneous lead)"],
    ["homogeneous-lead", "Arm B · homogeneous lead"],
    ["no-independent-verifier", "Arm C ablation · no independent verifier"],
  ]);
  const arms: ArmOutcome[] = spec.arms.map((armSpec) => {
    const id = String(armSpec.id);
    const role = armRole.get(id) ?? id;
    const runs = runsByArm.get(id as ExecutedArmId);
    return runs
      ? executedOutcome(id as ExecutedArmId, role, runs)
      : { id, role, executed: false, reason: "No offline executor is registered for this arm." };
  });

  const baselineRuns = runsByArm.get("single-worker");
  const treatmentRuns = runsByArm.get("heterogeneous-lead");
  if (!baselineRuns || !treatmentRuns) throw new Error("Baseline and treatment arms must both execute");
  const baselineAggregate = aggregateRuns(baselineRuns);
  const treatmentAggregate = aggregateRuns(treatmentRuns);
  const baselineReports = baselineRuns.map((run) => run.report);
  const treatmentReports = treatmentRuns.map((run) => run.report);
  const perCriterion: CriterionDelta[] = treatmentReports[0]!.criteria.map((criterion) => {
    const baselinePassRate = passRate(baselineReports, criterion.id);
    const treatmentPassRate = passRate(treatmentReports, criterion.id);
    return {
      id: criterion.id,
      label: criterion.label,
      baseline: baselinePassRate === 1 ? "pass" : "fail",
      treatment: treatmentPassRate === 1 ? "pass" : "fail",
      changed: baselinePassRate !== treatmentPassRate,
      baselinePassRate,
      treatmentPassRate,
    };
  });

  const baselineScore = baselineAggregate.score.mean;
  const treatmentScore = treatmentAggregate.score.mean;
  const baselineCriticalFailures = Object.keys(baselineAggregate.criticalFailures).sort();
  const treatmentCriticalFailures = Object.keys(treatmentAggregate.criticalFailures).sort();
  const report: ExperimentComparisonReport = {
    version: "1",
    experimentId: spec.id,
    generatedAt,
    doctrineHash,
    scenario: { id: SELF_BUILD_SCENARIO.scenarioId, fixture: SELF_BUILD_SCENARIO.fixture },
    seed: {
      count: seeds.length,
      values: seeds,
      note:
        seeds.length === 1
          ? `Single repetition retained for backward compatibility; spec declares repetitions=${spec.repetitions}.`
          : `${seeds.length} distinct repetitions; spec declares repetitions=${spec.repetitions}.`,
    },
    evaluator: { digestSha256: await evaluatorDigest(), threshold: treatmentReports[0]!.threshold },
    arms,
    comparison: {
      baselineArm: "single-worker",
      treatmentArm: "heterogeneous-lead",
      baselineScore,
      treatmentScore,
      scoreDelta: treatmentScore - baselineScore,
      baselinePassed: baselineAggregate.passedRate === 1,
      treatmentPassed: treatmentAggregate.passedRate === 1,
      treatmentBeatsBaseline:
        treatmentScore >= baselineScore &&
        treatmentAggregate.passedRate === 1 &&
        treatmentAggregate.criticalFailureCount === 0,
      baselineCriticalFailures,
      treatmentCriticalFailures,
      perCriterion,
    },
    scenariosDeclaredButUnimplemented: spec.scenarios.filter(
      (scenario) => scenario !== SELF_BUILD_SCENARIO.scenarioId,
    ),
    promotion: {
      ...spec.promotion,
      note: "Promotion also requires holdout improvement and human approval (docs/02); this report covers the offline simulated comparison only.",
    },
  };

  let artifactDirectory: string | undefined;
  if (options.outputDirectory) {
    artifactDirectory = resolve(options.outputDirectory);
    await rm(artifactDirectory, { recursive: true, force: true });
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(
      join(artifactDirectory, "lead-vs-single-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(artifactDirectory, "lead-vs-single-report.md"),
      comparisonToMarkdown(report),
      "utf8",
    );
    for (const arm of arms.filter((candidate) => candidate.executed)) {
      const runs = runsByArm.get(arm.id as ExecutedArmId);
      if (!runs || !arm.aggregate) continue;
      const armDirectory = join(artifactDirectory, arm.id);
      await writeArmRunArtifacts(armDirectory, runs[0]!);
      await writeFile(
        join(armDirectory, "aggregate-scorecard.json"),
        `${JSON.stringify(arm.aggregate, null, 2)}\n`,
        "utf8",
      );
      if (runs.length > 1) {
        for (const [index, run] of runs.entries()) {
          const repetitionDirectory = join(
            armDirectory,
            "repetitions",
            `${String(index + 1).padStart(3, "0")}-${createHash("sha256").update(run.seed).digest("hex").slice(0, 8)}`,
          );
          await writeArmRunArtifacts(repetitionDirectory, run);
        }
      }
    }
  }

  const armEvents = Object.fromEntries(
    [...runsByArm.entries()].map(([armId, runs]) => [armId, runs[0]?.events ?? []]),
  );
  const armRepetitions = Object.fromEntries(
    [...runsByArm.entries()].map(([armId, runs]) => [
      armId,
      runs.map((run) => ({ seed: run.seed, events: run.events })),
    ]),
  );
  return {
    report,
    ...(artifactDirectory ? { artifactDirectory } : {}),
    armEvents,
    armRepetitions,
  };
}

async function writeArmRunArtifacts(directory: string, run: ExecutedArmRun): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "scorecard.json"), `${JSON.stringify(run.report, null, 2)}\n`, "utf8");
  await writeFile(join(directory, "scorecard.md"), reportToMarkdown(run.report), "utf8");
  await writeFile(join(directory, "seed.txt"), `${run.seed}\n`, "utf8");
  await writeFile(
    join(directory, "events.jsonl"),
    `${run.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  const auditStore = new JsonlEventStore(join(directory, "audit.jsonl"));
  for (const event of run.events) await auditStore.append(event);
  const auditVerification = await auditStore.verify();
  if (!auditVerification.valid) {
    throw new Error(auditVerification.error ?? `${run.armId}@${run.seed} audit chain verification failed`);
  }
  await writeFile(
    join(directory, "audit-verification.json"),
    `${JSON.stringify(auditVerification, null, 2)}\n`,
    "utf8",
  );
}

export function comparisonToMarkdown(report: ExperimentComparisonReport): string {
  const comparison = report.comparison;
  const criterionRows = comparison.perCriterion
    .map(
      (delta) =>
        `| ${delta.label} | ${(delta.baselinePassRate * 100).toFixed(0)}% | ${(delta.treatmentPassRate * 100).toFixed(0)}% | ${delta.changed ? "→" : ""} |`,
    )
    .join("\n");
  const armRows = report.arms
    .map((arm) => {
      if (!arm.executed || !arm.aggregate) {
        return `| ${arm.id} | ${arm.role} | skipped | ${arm.reason ?? ""} |`;
      }
      const mean = (arm.aggregate.score.mean * 100).toFixed(1);
      const spread = (arm.aggregate.score.spread * 100).toFixed(1);
      return `| ${arm.id} | ${arm.role} | ${mean}% (spread ${spread} pts; n=${arm.aggregate.repetitions}) | ${arm.aggregate.passedRate === 1 ? "PASS" : "FAIL"} |`;
    })
    .join("\n");
  return (
    `# Experiment comparison: ${report.experimentId}\n\n` +
    `**Scenario:** ${report.scenario.id} (fixture \`${report.scenario.fixture}\`)  \n` +
    `**Doctrine hash:** \`${report.doctrineHash}\`  \n` +
    `**Evaluator digest (sha256):** \`${report.evaluator.digestSha256}\` · threshold ${(report.evaluator.threshold * 100).toFixed(0)}%  \n` +
    `**Seeds (${report.seed.count}):** ${report.seed.values.map((seed) => `\`${seed}\``).join(", ")}  \n` +
    `**Generated:** ${report.generatedAt}\n\n` +
    `## Verdict\n\n` +
    `Treatment (Arm C) mean score **${(comparison.treatmentScore * 100).toFixed(1)}%** vs baseline (Arm A) **${(comparison.baselineScore * 100).toFixed(1)}%** — delta **${(comparison.scoreDelta * 100).toFixed(1)} pts**. ` +
    `Treatment beats baseline: **${comparison.treatmentBeatsBaseline ? "YES" : "NO"}** (all treatment repetitions passed=${comparison.treatmentPassed}, all baseline repetitions passed=${comparison.baselinePassed}).\n\n` +
    `Baseline critical failures: ${comparison.baselineCriticalFailures.length ? comparison.baselineCriticalFailures.join(", ") : "none"}.\n` +
    `Treatment critical failures: ${comparison.treatmentCriticalFailures.length ? comparison.treatmentCriticalFailures.join(", ") : "none"}.\n\n` +
    `## Arms\n\n| Arm | Role | Mean score | Result |\n|---|---|---:|---|\n${armRows}\n\n` +
    `## Per-criterion (baseline → treatment)\n\n| Criterion | Baseline pass rate | Treatment pass rate | Δ |\n|---|---:|---:|---|\n${criterionRows}\n\n` +
    `## Not yet implemented\n\nScenarios declared but unimplemented: ${report.scenariosDeclaredButUnimplemented.join(", ") || "none"}.\n\n` +
    `${report.promotion.note}\n`
  );
}
