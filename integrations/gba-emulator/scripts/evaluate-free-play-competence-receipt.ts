import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  evaluateFreePlayCompetenceReceipt,
  loadFreePlayCompetenceBenchmark,
  runFreePlayCompetenceBenchmark,
} from "../src/free-play-competence.ts";
import { createRomCompetenceCoreLoader } from "./free-play-competence-rom.ts";

const receiptPath = process.env["CLANKIE_GBA_COMPETENCE_RECEIPT_PATH"];
if (receiptPath === undefined || receiptPath.trim().length === 0) {
  throw new Error("CLANKIE_GBA_COMPETENCE_RECEIPT_PATH is required");
}
const benchmark = loadFreePlayCompetenceBenchmark(
  path.resolve(import.meta.dirname, "../fixtures/free-play/competence-benchmark-v1.json"),
);
const freshReport = await runFreePlayCompetenceBenchmark({
  benchmark,
  rootDir: mkdtempSync(path.join(tmpdir(), "clankie-free-play-competence-evaluator-")),
  mode: "rom_gated",
  coreForState: createRomCompetenceCoreLoader(),
});
const report = await evaluateFreePlayCompetenceReceipt(receiptPath, {
  benchmark,
  expectedReport: freshReport,
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
