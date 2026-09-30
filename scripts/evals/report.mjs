#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Compare only matched cases on the same harness/model/suite and instruction/skill hashes. */
export function summarize(reports) {
  const groups = new Map();
  for (const report of reports) {
    for (const row of report.results) {
      const key = JSON.stringify([
        row.harness,
        report.version,
        report.cliSha256,
        report.runnerSha256,
        row.model,
        report.suiteSha256,
        row.config,
        row.condition?.instructionsSha256,
        row.condition?.skills,
      ]);
      if (!groups.has(key))
        groups.set(key, {
          harness: row.harness,
          cliVersion: report.version,
          runnerSha256: report.runnerSha256,
          model: row.model,
          suiteSha256: report.suiteSha256,
          config: row.config,
          cases: new Map(),
          tokens: 0,
          unknownUsage: 0,
          wallMs: 0,
          rework: 0,
          toolFailures: 0,
        });
      const group = groups.get(key);
      const caseKey = `${report.id}/${row.caseId}`;
      group.cases.set(caseKey, {
        id: row.caseId,
        passed: (group.cases.get(caseKey)?.passed ?? false) || row.passed,
      });
      if (row.tokens) group.tokens += row.tokens.total;
      else group.unknownUsage++;
      group.wallMs += row.wallMs ?? 0;
      if (row.attempt > 0) group.rework++;
      group.toolFailures += row.toolFailures ?? 0;
    }
  }
  return [...groups.values()].map((group) => ({
    ...group,
    cases: undefined,
    caseIds: [...new Set([...group.cases.values()].map((c) => c.id))].sort(),
    trials: group.cases.size,
    passed: [...group.cases.values()].filter((c) => c.passed).length,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length < 3) {
    console.error("Usage: node scripts/evals/report.mjs REPORT.json [REPORT.json ...]");
    process.exitCode = 1;
  } else
    console.log(
      JSON.stringify(
        {
          groups: summarize(process.argv.slice(2).map((path) => JSON.parse(readFileSync(path, "utf8")))),
          caveat:
            "Compare quality only on matched case IDs and repeated trials. Tokens are provider-reported, not subscription quota. Unknown usage is not zero. Failed attempts remain in cost and rework.",
        },
        null,
        2,
      ),
    );
}
