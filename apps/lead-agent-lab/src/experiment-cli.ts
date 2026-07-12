import { join } from "node:path";
import { runExperiment } from "./experiment.ts";
import { repoRoot } from "./lab.ts";

const writeArtifacts = process.argv.includes("--write-artifacts");
const outputDirectory = writeArtifacts ? join(repoRoot, "artifacts/evals/experiment") : undefined;
const run = outputDirectory ? await runExperiment({ outputDirectory }) : await runExperiment();
const c = run.report.comparison;

console.log(`Experiment: ${run.report.experimentId} · scenario ${run.report.scenario.id}`);
console.log(
  `Treatment (Arm C) ${(c.treatmentScore * 100).toFixed(1)}% vs baseline (Arm A) ${(c.baselineScore * 100).toFixed(1)}% · delta ${(c.scoreDelta * 100).toFixed(1)} pts`,
);
console.log(`Treatment beats baseline: ${c.treatmentBeatsBaseline ? "YES" : "NO"}`);
console.log(`Doctrine hash: ${run.report.doctrineHash}`);
if (run.artifactDirectory) console.log(`Artifacts: ${run.artifactDirectory}`);
if (!c.treatmentBeatsBaseline) {
  console.error("Treatment did not beat the baseline; inspect the comparison report.");
  process.exitCode = 1;
}
