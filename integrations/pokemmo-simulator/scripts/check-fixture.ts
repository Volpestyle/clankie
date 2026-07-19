import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FrozenPokeMMOScenarioSchema, PokeMMOScenarioBindingSchema } from "../src/contracts.ts";

const fixtureRoot = resolve(import.meta.dirname, "../../../scenarios/pokemmo/navigation-trainer-battle/v1");
const scenarioBytes = await readFile(resolve(fixtureRoot, "scenario.json"));
const digest = createHash("sha256").update(scenarioBytes).digest("hex");
const sidecar = (await readFile(resolve(fixtureRoot, "scenario.sha256"), "utf8")).trim();
if (sidecar !== `${digest}  scenario.json`) throw new Error("Frozen PokeMMO scenario hash drifted");
const scenario = FrozenPokeMMOScenarioSchema.parse(JSON.parse(scenarioBytes.toString("utf8")));
const binding = PokeMMOScenarioBindingSchema.parse(
  JSON.parse(await readFile(resolve(fixtureRoot, "binding.json"), "utf8")),
);
if (
  binding.fixtureSha256 !== digest ||
  binding.scenarioId !== scenario.scenarioId ||
  binding.scenarioVersion !== scenario.scenarioVersion
) {
  throw new Error("Frozen PokeMMO binding does not match scenario identity");
}
process.stdout.write(`${JSON.stringify({ scenarioId: scenario.scenarioId, fixtureSha256: digest })}\n`);
