import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runFrozenPokeMMOScenario } from "../src/scenario.ts";

const fixtureRoot = resolve(import.meta.dirname, "../../../scenarios/pokemmo/navigation-trainer-battle/v1");
const scenarioBytes = await readFile(resolve(fixtureRoot, "scenario.json"));
const fixtureSha256 = createHash("sha256").update(scenarioBytes).digest("hex");
const sidecar = (await readFile(resolve(fixtureRoot, "scenario.sha256"), "utf8")).trim();
if (sidecar !== `${fixtureSha256}  scenario.json`) throw new Error("Frozen scenario hash drifted");
const scenario = JSON.parse(scenarioBytes.toString("utf8")) as unknown;
const binding = JSON.parse(await readFile(resolve(fixtureRoot, "binding.json"), "utf8")) as unknown;

const requestedOutput = process.argv[2];
const temporaryRoot = await mkdtemp(join(tmpdir(), "clankie-pokemmo-scenario-"));
try {
  const result = await runFrozenPokeMMOScenario({
    rootDir: resolve(temporaryRoot, "runtime"),
    scenario,
    binding,
    fixtureSha256,
  });
  const outputRoot = requestedOutput ? resolve(requestedOutput) : resolve(temporaryRoot, "evidence");
  await mkdir(outputRoot, { recursive: true });
  const files = {
    "report.json": `${JSON.stringify(result.report, null, 2)}\n`,
    "events.json": `${JSON.stringify(result.trace, null, 2)}\n`,
    "semantic-events.json": `${JSON.stringify(result.semanticEvents, null, 2)}\n`,
  };
  const hashes: Record<string, string> = {};
  for (const [filename, content] of Object.entries(files)) {
    await writeFile(resolve(outputRoot, filename), content, "utf8");
    hashes[filename] = createHash("sha256").update(content).digest("hex");
  }
  if (hashes["events.json"] !== result.report.artifacts[0]?.sha256) {
    throw new Error("Scenario report event-trace artifact hash disagrees with emitted bytes");
  }
  const validation = {
    schemaVersion: 1,
    result: result.report.result,
    scenarioId: result.report.scenarioId,
    fixtureSha256,
    files: hashes,
  };
  await writeFile(resolve(outputRoot, "validation.json"), `${JSON.stringify(validation, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(validation)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
