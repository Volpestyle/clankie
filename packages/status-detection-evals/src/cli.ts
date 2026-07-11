import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluateStatusCorpus, loadFrozenCorpus, statusReportToMarkdown } from "./index.ts";

const loaded = await loadFrozenCorpus();
const report = await evaluateStatusCorpus(loaded.corpus, loaded.corpusHash, loaded.transcripts);
const outputDirectory = join(import.meta.dirname, "..", "artifacts", "evals", "status-detection");
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`),
  writeFile(join(outputDirectory, "report.md"), statusReportToMarkdown(report)),
]);
console.log(statusReportToMarkdown(report));
if (!report.passed) process.exitCode = 1;
