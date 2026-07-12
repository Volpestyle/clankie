import { runHerdrHarnessArm } from "./herdr-harness.ts";

try {
  const result = await runHerdrHarnessArm();
  process.stdout.write(`Consumer-harness Herdr arm: ${result.result}\n`);
  process.stdout.write(`Run: ${result.runId}\n`);
  process.stdout.write(`Artifacts: ${result.outputDirectory}\n`);
  process.exitCode = result.result === "PASS" ? 0 : 1;
} catch (error) {
  process.stderr.write(`herdr-harness driver failed: ${String(error)}\n`);
  process.exitCode = 1;
}
