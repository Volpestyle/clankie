import type { SettleClassification } from "@clankie/settle-classifier";
import type { StatusEvaluationReport } from "./types.ts";

const LABELS: readonly SettleClassification[] = [
  "awaiting_input_required",
  "finished_with_offer",
  "finished",
  "errored",
];

export function statusReportToMarkdown(report: StatusEvaluationReport): string {
  const classRows = LABELS.map((label) => {
    const metric = report.classification[label];
    return `| ${metric.passed ? "PASS" : "FAIL"} | ${label} | ${percent(metric.precision)} / ${percent(metric.target.precision)} | ${percent(metric.recall)} / ${percent(metric.target.recall)} | ${metric.truePositive} / ${metric.falsePositive} / ${metric.falseNegative} |`;
  }).join("\n");
  const fixtureRows = report.fixtures
    .map(
      (fixture) =>
        `| ${fixture.id} | ${fixture.expectedState} | ${fixture.tier2State} | ${fixture.fullLadderState} | ${fixture.selectedTier ?? "none"} |`,
    )
    .join("\n");
  return `# Status-detection evaluation: ${report.corpusId}

**Result:** ${report.passed ? "PASS" : "FAIL"}

**Corpus SHA-256:** \`${report.corpusHash}\`

**Generated:** ${report.generatedAt}

## Per-class precision and recall

| Result | Class | Precision / target | Recall / target | TP / FP / FN |
|---|---|---:|---:|---:|
${classRows}

## Tier ablation

| Lane | Correct | Accuracy | Target |
|---|---:|---:|---:|
| Tier 2 alone | ${report.ablation.tier2Correct}/${report.ablation.fixtureCount} | ${percent(report.ablation.tier2Accuracy)} | ${percent(report.ablation.targets.tier2Accuracy)} |
| Tier 0/1 + 2 reference ladder | ${report.ablation.fullLadderCorrect}/${report.ablation.fixtureCount} | ${percent(report.ablation.fullLadderAccuracy)} | ${percent(report.ablation.targets.fullLadderAccuracy)} |

Full-ladder lift is ${percent(report.ablation.fullLadderLift)} (target ${percent(report.ablation.targets.minimumFullLadderLift)}). Higher-tier override violations: ${report.ablation.higherTierOverrideViolations} (maximum ${report.ablation.targets.maximumHigherTierOverrideViolations}).

## Fixture outcomes

| Fixture | Expected | Tier 2 | Full ladder | Selected tier |
|---|---|---|---|---:|
${fixtureRows}

## Limitations

${report.limitations.map((item) => `- ${item}`).join("\n")}
`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
