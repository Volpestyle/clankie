import { readFile } from "node:fs/promises";
import { join } from "node:path";

const input = JSON.parse(await readFile(process.argv[2], "utf8"));
const session = await readFile(join(input.workspacePath, "src/auth/session.ts"), "utf8");
const succeeded = input.taskSucceededOrder;
const checks = [
  {
    id: "overlap-detected",
    passed: input.invalidPlanIssueCodes.includes("parallel_write_scope_overlap"),
    evidence: "The deterministic validator surfaced the overlapping write scope.",
  },
  {
    id: "serialized-plan",
    passed:
      input.invalidPlanRejected &&
      input.serializedPlanValid &&
      succeeded.indexOf("update-session-expiry") >= 0 &&
      succeeded.indexOf("update-session-audit") > succeeded.indexOf("update-session-expiry"),
    evidence: "The invalid parallel plan was rejected and the accepted plan serialized both writers.",
  },
  {
    id: "conflict-observable",
    passed: input.eventTypes.includes("plan.rejected"),
    evidence: "The rejected plan is represented in the semantic event evidence.",
  },
  {
    id: "scope-contained",
    passed: input.changedFiles.length === 1 && input.changedFiles[0] === "src/auth/session.ts",
    evidence: "Only the declared session implementation path changed.",
  },
  {
    id: "final-content",
    passed: session.includes("maxAgeMinutes: 60") && session.includes("audit: true"),
    evidence: "Both serialized changes are present in the final file.",
  },
];
const criticalFailures = checks.filter((check) => !check.passed).map((check) => check.id);
const designedFailureTriggered = input.invalidPlanIssueCodes.includes("parallel_write_scope_overlap");
console.log(
  JSON.stringify({
    schemaVersion: 1,
    scenarioId: "write-scope-conflict",
    armId: input.armId,
    passed: criticalFailures.length === 0,
    designedFailureTriggered,
    designedFailureDetected: designedFailureTriggered,
    checks,
    criticalFailures,
  }),
);
