import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { reportToMarkdown, type LeadEvaluationReport } from "@clankie/evals";
import { JsonlEventStore } from "@clankie/event-store";
import type { DomainEvent } from "@clankie/protocol";
import { runSingleAgentBaseline } from "./baseline.ts";
import { runSelfBuildLab, SELF_BUILD_SCENARIO, repoRoot } from "./lab.ts";

interface ExperimentSpec {
  id: string;
  arms: Array<Record<string, unknown>>;
  scenarios: string[];
  repetitions: number;
  metrics: string[];
  promotion: Record<string, unknown>;
}

export interface ArmOutcome {
  id: string;
  role: string;
  executed: boolean;
  reason?: string;
  report?: LeadEvaluationReport;
  criticalFailures?: string[];
  groundTruthPassed?: boolean;
}

export interface CriterionDelta {
  id: string;
  label: string;
  baseline: "pass" | "fail";
  treatment: "pass" | "fail";
  changed: boolean;
}

export interface ExperimentComparisonReport {
  version: "1";
  experimentId: string;
  generatedAt: string;
  doctrineHash: string;
  scenario: { id: string; fixture: string };
  seed: { count: number; note: string };
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
}

export interface ExperimentRun {
  report: ExperimentComparisonReport;
  artifactDirectory?: string;
  armEvents: Record<string, DomainEvent[]>;
}

async function evaluatorDigest(): Promise<string> {
  const source = await readFile(join(repoRoot, "packages/evals/src/index.ts"), "utf8");
  return createHash("sha256").update(source).digest("hex");
}

function passFail(report: LeadEvaluationReport, criterionId: string): "pass" | "fail" {
  return report.criteria.find((c) => c.id === criterionId)?.passed ? "pass" : "fail";
}

/**
 * Executes the offline lead-vs-single comparison: Arm A (unconstrained single
 * agent) and Arm C (lead-orchestrated treatment) over the self-build scenario,
 * each scored by the UNCHANGED `evaluateLeadRun`. Arms declared in the spec but
 * without an offline executor (Arm B homogeneous, the ablation) are recorded as
 * skipped rather than silently dropped.
 */
export async function runExperiment(options: RunExperimentOptions = {}): Promise<ExperimentRun> {
  const specPath = join(repoRoot, "evals/experiments/lead-vs-single.yaml");
  const spec = parseYaml(await readFile(specPath, "utf8")) as ExperimentSpec;
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const baseline = await runSingleAgentBaseline({ generatedAt });
  const treatment = await runSelfBuildLab({ generatedAt });
  const treatmentProfileHash = String(treatment.events[0]?.profileHash ?? baseline.profileHash);
  if (treatmentProfileHash !== baseline.profileHash) {
    throw new Error(
      `Arms ran under different doctrine hashes (baseline=${baseline.profileHash}, treatment=${treatmentProfileHash}); comparison would be invalid.`,
    );
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
    if (id === "single-worker") {
      return {
        id,
        role,
        executed: true,
        report: baseline.report,
        criticalFailures: baseline.report.criticalFailures,
        groundTruthPassed: baseline.groundTruthPassed,
      };
    }
    if (id === "heterogeneous-lead") {
      return {
        id,
        role,
        executed: true,
        report: treatment.report,
        criticalFailures: treatment.report.criticalFailures,
      };
    }
    return {
      id,
      role,
      executed: false,
      reason: "No offline executor for this arm in this slice; requires a dedicated harness (follow-up).",
    };
  });

  const perCriterion: CriterionDelta[] = treatment.report.criteria.map((tc) => {
    const baseline_ = passFail(baseline.report, tc.id);
    const treatment_ = passFail(treatment.report, tc.id);
    return {
      id: tc.id,
      label: tc.label,
      baseline: baseline_,
      treatment: treatment_,
      changed: baseline_ !== treatment_,
    };
  });

  const report: ExperimentComparisonReport = {
    version: "1",
    experimentId: spec.id,
    generatedAt,
    doctrineHash: baseline.profileHash,
    scenario: { id: SELF_BUILD_SCENARIO.scenarioId, fixture: SELF_BUILD_SCENARIO.fixture },
    seed: {
      count: 1,
      note: `Single-seed slice; spec declares repetitions=${spec.repetitions}. Cross-seed statistics deferred (VUH-699 gap G7).`,
    },
    evaluator: { digestSha256: await evaluatorDigest(), threshold: treatment.report.threshold },
    arms,
    comparison: {
      baselineArm: "single-worker",
      treatmentArm: "heterogeneous-lead",
      baselineScore: baseline.report.overallScore,
      treatmentScore: treatment.report.overallScore,
      scoreDelta: treatment.report.overallScore - baseline.report.overallScore,
      baselinePassed: baseline.report.passed,
      treatmentPassed: treatment.report.passed,
      treatmentBeatsBaseline:
        treatment.report.overallScore >= baseline.report.overallScore && treatment.report.passed,
      baselineCriticalFailures: baseline.report.criticalFailures,
      treatmentCriticalFailures: treatment.report.criticalFailures,
      perCriterion,
    },
    scenariosDeclaredButUnimplemented: spec.scenarios.filter((s) => s !== SELF_BUILD_SCENARIO.scenarioId),
    promotion: {
      ...spec.promotion,
      note: "Promotion also requires holdout improvement and human approval (docs/02); this slice proves the offline single-seed comparison only.",
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
    for (const [armId, run] of [
      ["single-worker", baseline] as const,
      ["heterogeneous-lead", treatment] as const,
    ]) {
      const armDir = join(artifactDirectory, armId);
      await mkdir(armDir, { recursive: true });
      await writeFile(join(armDir, "scorecard.json"), `${JSON.stringify(run.report, null, 2)}\n`, "utf8");
      await writeFile(join(armDir, "scorecard.md"), reportToMarkdown(run.report), "utf8");
      await writeFile(
        join(armDir, "events.jsonl"),
        `${run.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
        "utf8",
      );
      const auditStore = new JsonlEventStore(join(armDir, "audit.jsonl"));
      for (const event of run.events) await auditStore.append(event);
      const auditVerification = await auditStore.verify();
      if (!auditVerification.valid) {
        throw new Error(auditVerification.error ?? `${armId} audit chain verification failed`);
      }
      await writeFile(
        join(armDir, "audit-verification.json"),
        `${JSON.stringify(auditVerification, null, 2)}\n`,
        "utf8",
      );
    }
  }

  return {
    report,
    ...(artifactDirectory ? { artifactDirectory } : {}),
    armEvents: { "single-worker": baseline.events, "heterogeneous-lead": treatment.events },
  };
}

export function comparisonToMarkdown(report: ExperimentComparisonReport): string {
  const c = report.comparison;
  const criterionRows = c.perCriterion
    .map(
      (d) =>
        `| ${d.label} | ${d.baseline === "pass" ? "PASS" : "FAIL"} | ${d.treatment === "pass" ? "PASS" : "FAIL"} | ${d.changed ? "→" : ""} |`,
    )
    .join("\n");
  const armRows = report.arms
    .map(
      (a) =>
        `| ${a.id} | ${a.role} | ${a.executed ? `${((a.report?.overallScore ?? 0) * 100).toFixed(1)}%` : "skipped"} | ${a.executed ? (a.report?.passed ? "PASS" : "FAIL") : (a.reason ?? "")} |`,
    )
    .join("\n");
  return (
    `# Experiment comparison: ${report.experimentId}\n\n` +
    `**Scenario:** ${report.scenario.id} (fixture \`${report.scenario.fixture}\`)  \n` +
    `**Doctrine hash:** \`${report.doctrineHash}\`  \n` +
    `**Evaluator digest (sha256):** \`${report.evaluator.digestSha256}\` · threshold ${(report.evaluator.threshold * 100).toFixed(0)}%  \n` +
    `**Seed:** ${report.seed.count} — ${report.seed.note}  \n` +
    `**Generated:** ${report.generatedAt}\n\n` +
    `## Verdict\n\n` +
    `Treatment (Arm C) score **${(c.treatmentScore * 100).toFixed(1)}%** vs baseline (Arm A) **${(c.baselineScore * 100).toFixed(1)}%** — delta **${(c.scoreDelta * 100).toFixed(1)} pts**. ` +
    `Treatment beats baseline: **${c.treatmentBeatsBaseline ? "YES" : "NO"}** (treatment passed=${c.treatmentPassed}, baseline passed=${c.baselinePassed}).\n\n` +
    `Baseline critical failures: ${c.baselineCriticalFailures.length ? c.baselineCriticalFailures.join(", ") : "none"}.\n` +
    `Treatment critical failures: ${c.treatmentCriticalFailures.length ? c.treatmentCriticalFailures.join(", ") : "none"}.\n\n` +
    `## Arms\n\n| Arm | Role | Score | Result |\n|---|---|---:|---|\n${armRows}\n\n` +
    `## Per-criterion (baseline → treatment)\n\n| Criterion | Baseline | Treatment | Δ |\n|---|---|---|---|\n${criterionRows}\n\n` +
    `## Not yet implemented\n\nScenarios declared but unimplemented: ${report.scenariosDeclaredButUnimplemented.join(", ") || "none"}.\n\n` +
    `${report.promotion.note}\n`
  );
}
