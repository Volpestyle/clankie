import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FrozenGbaScenarioSchema, GbaScenarioBindingSchema } from "../src/contracts.ts";
import { savestateIdentitySha256 } from "../src/core-double.ts";

const fixtureRoot = resolve(
  import.meta.dirname,
  "../../../scenarios/emulator/verdant-path-trainer-battle/v1",
);
const scenarioBytes = await readFile(resolve(fixtureRoot, "scenario.json"));
const digest = createHash("sha256").update(scenarioBytes).digest("hex");
const sidecar = (await readFile(resolve(fixtureRoot, "scenario.sha256"), "utf8")).trim();
if (sidecar !== `${digest}  scenario.json`) throw new Error("Frozen GBA scenario hash drifted");
const scenario = FrozenGbaScenarioSchema.parse(JSON.parse(scenarioBytes.toString("utf8")));
if (savestateIdentitySha256(scenario.savestateId) !== scenario.savestateSha256) {
  throw new Error("Frozen GBA savestate identity digest drifted");
}
const binding = GbaScenarioBindingSchema.parse(
  JSON.parse(await readFile(resolve(fixtureRoot, "binding.json"), "utf8")),
);
if (
  binding.fixtureSha256 !== digest ||
  binding.scenarioId !== scenario.scenarioId ||
  binding.scenarioVersion !== scenario.scenarioVersion
) {
  throw new Error("Frozen GBA binding does not match scenario identity");
}
process.stdout.write(`${JSON.stringify({ scenarioId: scenario.scenarioId, fixtureSha256: digest })}\n`);
