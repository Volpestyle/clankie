import { isCommittedRealWorkerRun, runRealWorkerEvaluation } from "./real-workers.ts";

try {
  const run = await runRealWorkerEvaluation();
  if (!(await isCommittedRealWorkerRun(run.outputDirectory))) {
    throw new Error("Real-provider worker evaluation did not publish a committed result.");
  }
  console.log("Real-provider worker evaluation: PASS");
  console.log(`Mission: ${run.missionId}`);
  console.log(`Artifacts: ${run.outputDirectory}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
