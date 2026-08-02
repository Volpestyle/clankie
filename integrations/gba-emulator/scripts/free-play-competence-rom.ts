import { readFileSync } from "node:fs";
import path from "node:path";
import {
  defaultGbaGameDir,
  MgbaFireRedCore,
  RealGbaRouteScenarioSchema,
  type FreePlayCompetenceCoreHandle,
} from "../src/index.ts";

/** Load operator-owned ROM material without ever copying it into an artifact. */
export function createRomCompetenceCoreLoader(
  env: NodeJS.ProcessEnv = process.env,
): (_state: unknown, scenario: unknown) => Promise<FreePlayCompetenceCoreHandle> {
  const gameDir = defaultGbaGameDir(env);
  const romPath = env["CLANKIE_GBA_ROM_PATH"] ?? path.join(gameDir, "firered.gba");
  const savestatePath = env["CLANKIE_GBA_SAVESTATE_PATH"] ?? path.join(gameDir, "firered-bedroom.state");
  const romBytes = readFileSync(romPath);
  const savestateBytes = readFileSync(savestatePath);
  return async (_state, rawScenario) => {
    const scenario = RealGbaRouteScenarioSchema.parse(rawScenario);
    const core = await MgbaFireRedCore.create({
      coreId: scenario.coreId,
      romBytes,
      savestateBytes,
      romSha256: scenario.romSha256,
      savestateSha256: scenario.savestateSha256,
      coreWasmSha256: scenario.coreWasmSha256,
      mapId: scenario.map.mapId,
    });
    return { coreFactory: () => core, identity: core.identity() };
  };
}
