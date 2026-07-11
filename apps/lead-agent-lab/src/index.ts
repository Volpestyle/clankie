import { join } from "node:path";
import { runSelfBuildLab, repoRoot } from "./lab.ts";

const writeArtifacts = process.argv.includes("--write-artifacts");
const outputDirectory = writeArtifacts ? join(repoRoot, "artifacts/evals/self-build") : undefined;
const run = outputDirectory ? await runSelfBuildLab({ outputDirectory }) : await runSelfBuildLab();

console.log(`Lead-agent self-build evaluation: ${run.report.passed ? "PASS" : "FAIL"}`);
console.log(`Score: ${(run.report.overallScore * 100).toFixed(1)}%`);
console.log(`Mission: ${run.report.missionId}`);
if (run.artifactDirectory) console.log(`Artifacts: ${run.artifactDirectory}`);
if (!run.report.passed) {
  console.error(`Critical failures: ${run.report.criticalFailures.join(", ") || "none"}`);
  process.exitCode = 1;
}
