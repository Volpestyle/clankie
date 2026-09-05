/**
 * Judges one Vitest JSON report against the shape the case-A flow requires.
 *
 *   node assert-suite.mjs REPORT.json red|green EXPECTED_TOTAL "regression test title"
 *
 * Exit 0 only when the report is exactly the expected shape. `red` demands the
 * named regression and nothing else; `green` demands a clean full suite. A run
 * that collects no tests, fails to import, or fails a different test exits
 * non-zero — those look like success to a bare exit-code check and would let a
 * broken harness pass for evidence.
 */
import { readFileSync } from "node:fs";

const [file, mode, expectedTotal, regression] = process.argv.slice(2);
if (file === undefined || (mode !== "red" && mode !== "green")) {
  console.error('usage: assert-suite.mjs REPORT.json red|green EXPECTED_TOTAL "regression title"');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(file, "utf8"));
} catch {
  console.error(`  no readable JSON report at ${file} (the suite probably never ran)`);
  process.exit(1);
}

const total = report.numTotalTests ?? 0;
const failed = report.numFailedTests ?? 0;
const wantFailures = mode === "red" ? 1 : 0;
const failing = (report.testResults ?? [])
  .flatMap((suite) => suite.assertionResults ?? [])
  .filter((assertion) => assertion.status === "failed")
  .map((assertion) => assertion.title);

const problems = [];
if (total !== Number(expectedTotal)) problems.push(`collected ${total} tests, expected ${expectedTotal}`);
if (failed !== wantFailures) problems.push(`${failed} failed, expected ${wantFailures}`);
if (mode === "red" && (failing.length !== 1 || failing[0] !== regression)) {
  problems.push(`failures were ${JSON.stringify(failing)}, expected only ${JSON.stringify(regression)}`);
}
if (problems.length > 0) {
  console.error(`  ${problems.join("; ")}`);
  process.exit(1);
}
