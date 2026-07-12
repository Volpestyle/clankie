import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ScenarioBindingSchema, ScenarioReportSchema, verifierGoalEvent } from "../src/contracts.ts";

const evidenceRoot = process.argv[2];
if (!evidenceRoot) throw new Error("Usage: validate-evidence.ts <evidence-root>");

const packageRoot = resolve(import.meta.dirname, "..");
const bindingPath = resolve(packageRoot, "../../scenarios/minecraft/collect-craft-place/v1/binding.json");
const binding = ScenarioBindingSchema.parse(JSON.parse(await readFile(bindingPath, "utf8")));
const reports = ["success-fixture", "deliberate-failure-fixture"];
const results = [];

for (const runId of reports) {
  const relativePath = `scenario-evidence/${runId}/report.json`;
  const report = ScenarioReportSchema.parse(
    JSON.parse(await readFile(resolve(evidenceRoot, relativePath), "utf8")),
  );
  const event = verifierGoalEvent(report, binding, "2026-07-11T12:01:00.000Z");
  results.push({ path: relativePath, result: report.result, eventType: event.type });
}

await writeFile(
  resolve(evidenceRoot, "evidence-validation.json"),
  `${JSON.stringify({ schemaVersion: 1, fixtureSha256: binding.fixtureSha256, reports: results }, null, 2)}\n`,
);
