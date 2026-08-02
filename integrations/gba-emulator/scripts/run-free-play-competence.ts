import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildFreePlayCompetenceOperatorReceipt,
  FreePlayCompetenceOperatorReceiptSchema,
  loadFreePlayCompetenceBenchmark,
  runFreePlayCompetenceBenchmark,
  sha256,
} from "../src/index.ts";
import { createRomCompetenceCoreLoader } from "./free-play-competence-rom.ts";

type Mode = "deterministic_double" | "rom_gated" | "all";

const mode = parseMode(argument("--mode") ?? process.env["CLANKIE_GBA_COMPETENCE_MODE"]);
const benchmarkPath = path.resolve(import.meta.dirname, "../fixtures/free-play/competence-benchmark-v1.json");
const receiptDir = process.env["CLANKIE_GBA_COMPETENCE_RECEIPT_DIR"]?.trim();
if ((mode === "rom_gated" || mode === "all") && !receiptDir) {
  throw new Error("CLANKIE_GBA_COMPETENCE_RECEIPT_DIR is required for ROM-gated competence evidence");
}

const benchmark = loadFreePlayCompetenceBenchmark(benchmarkPath);
const coreForState = mode === "deterministic_double" ? undefined : createRomCompetenceCoreLoader();
const report = await runFreePlayCompetenceBenchmark({
  benchmark,
  rootDir: mkdtempSync(path.join(tmpdir(), "clankie-free-play-competence-")),
  mode,
  ...(coreForState === undefined ? {} : { coreForState }),
});

let receiptPath: string | undefined;
if (receiptDir) {
  mkdirSync(receiptDir, { recursive: true });
  const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(path.join(receiptDir, "free-play-competence-report.json"), reportBytes, {
    encoding: "utf8",
    mode: 0o600,
  });
  const receipt = buildFreePlayCompetenceOperatorReceipt({ report, reportSha256: sha256(reportBytes) });
  FreePlayCompetenceOperatorReceiptSchema.parse(receipt);
  receiptPath = path.join(receiptDir, "free-play-competence-receipt.json");
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

const output = {
  schemaVersion: 1,
  passed: report.result === "passed",
  benchmarkId: report.benchmarkId,
  benchmarkVersion: report.benchmarkVersion,
  benchmarkFixtureSha256: report.benchmarkFixtureSha256,
  mode: report.mode,
  runs: report.runs.map((run) => ({
    stateId: run.stateId,
    kind: run.kind,
    result: run.result,
    targetMilestoneId: run.targetMilestoneId,
    metrics: run.metrics,
    checks: run.checks,
  })),
  ...(receiptPath === undefined ? {} : { receiptPath }),
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
if (!output.passed) process.exitCode = 1;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function parseMode(raw: string | undefined): Mode {
  if (raw === undefined || raw.length === 0) return "deterministic_double";
  if (raw === "deterministic_double" || raw === "rom_gated" || raw === "all") return raw;
  throw new Error(`Unknown free-play competence mode: ${raw}`);
}
