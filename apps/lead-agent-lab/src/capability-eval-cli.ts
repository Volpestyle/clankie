import { resolve } from "node:path";
import {
  loadCapabilityManifest,
  runCapabilityEvaluation,
  writeCapabilityEvaluationArtifacts,
} from "./capability-eval.ts";
import { repoRoot } from "./lab.ts";

const manifest = await loadCapabilityManifest(repoRoot);
const report = await runCapabilityEvaluation(manifest, { repoRoot });
const outputDirectory = resolve(
  process.env.CLANKIE_CAPABILITY_EVAL_OUTPUT ?? `${repoRoot}/artifacts/evals/capabilities`,
);
const artifacts = await writeCapabilityEvaluationArtifacts(report, outputDirectory);

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`Clankie capability evaluation: ${report.passed ? "PASS" : "INCOMPLETE"}\n`);
  for (const capability of report.capabilities) {
    process.stdout.write(`${capability.status.padEnd(13)} ${capability.label}\n`);
  }
  process.stdout.write(`Artifacts: ${artifacts.jsonPath}\n`);
}
if (!report.passed) process.exitCode = 1;
