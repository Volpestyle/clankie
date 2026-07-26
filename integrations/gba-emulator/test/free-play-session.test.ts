import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FrozenGbaScenarioSchema } from "../src/contracts.ts";
import { sha256 } from "../src/core-double.ts";
import { defaultGbaBodyRootDir } from "../src/free-play-boot.ts";
import { createFreePlaySession } from "../src/free-play-session.ts";

const require = createRequire(import.meta.url);
const emulatorPackage = path.dirname(require.resolve("@clankie/gba-emulator/package.json"));
const scenarioPath = path.resolve(
  emulatorPackage,
  "../..",
  "scenarios/emulator/verdant-path-trainer-battle/v1/scenario.json",
);
const scenarioBytes = readFileSync(scenarioPath);
const scenario = FrozenGbaScenarioSchema.parse(JSON.parse(scenarioBytes.toString("utf8")));
const fixtureSha256 = sha256(scenarioBytes);

describe("shared body root", () => {
  it("refuses a second writer on the same body", async () => {
    // The whole point of a stable root: the MCP server and the free-play CLI
    // are separate processes, so the only thing that can stop them driving the
    // same game at once is a lease they can both see. Two temp dirs meant two
    // invisible bodies — the ADR 0053 footgun.
    const rootDir = mkdtempSync(path.join(tmpdir(), "shared-body-"));
    const first = await createFreePlaySession({ rootDir, scenario, fixtureSha256 });
    await expect(createFreePlaySession({ rootDir, scenario, fixtureSha256 })).rejects.toThrow(
      /body is already held/i,
    );
    first.close();
  });

  it("resolves the same root for every entrypoint", () => {
    const env = { XDG_STATE_HOME: mkdtempSync(path.join(tmpdir(), "state-")) } as NodeJS.ProcessEnv;
    expect(defaultGbaBodyRootDir(env)).toBe(defaultGbaBodyRootDir(env));
    const override = mkdtempSync(path.join(tmpdir(), "override-"));
    expect(defaultGbaBodyRootDir({ CLANKIE_GBA_BODY_ROOT: override } as NodeJS.ProcessEnv)).toBe(override);
  });
});

describe("observe-only sessions", () => {
  it("lets several coexist on one body", async () => {
    // An MCP client starts stdio servers freely — `claude mcp list`, every
    // session, every retry. Locking at construction made the first server win
    // and every later one fail to connect at all, which is contention over
    // existing rather than over the body. Observation is not driving.
    const rootDir = mkdtempSync(path.join(tmpdir(), "observe-only-"));
    const first = await createFreePlaySession({ rootDir, scenario, fixtureSha256, acquireBody: false });
    const second = await createFreePlaySession({ rootDir, scenario, fixtureSha256, acquireBody: false });
    expect(second.sessionId).toBe(first.sessionId);
    first.close();
    second.close();
  });

  it("still refuses a driver while an observer is up", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "observe-then-drive-"));
    const observer = await createFreePlaySession({ rootDir, scenario, fixtureSha256, acquireBody: false });
    const driver = await createFreePlaySession({ rootDir, scenario, fixtureSha256 });
    // The observer took nothing, so the driver gets the body; a second driver
    // does not.
    await expect(createFreePlaySession({ rootDir, scenario, fixtureSha256 })).rejects.toThrow(
      /body is already held/i,
    );
    driver.close();
    observer.close();
  });
});
