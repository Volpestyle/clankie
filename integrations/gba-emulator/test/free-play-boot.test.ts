import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bootGbaGame, defaultGbaGameDir } from "../src/free-play-boot.ts";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../fixtures");
const DOUBLE_SCENARIO = path.resolve(
  import.meta.dirname,
  "../../../scenarios/emulator/verdant-path-trainer-battle/v1/scenario.json",
);
const EMERALD_ROM = path.join(defaultGbaGameDir({}), "emerald.gba");

function bootOptions(env: NodeJS.ProcessEnv) {
  return { env, fixturesDir: FIXTURES_DIR, doubleScenarioPath: DOUBLE_SCENARIO };
}

describe("game path resolution", () => {
  it("maps the well-known game home under XDG_DATA_HOME", () => {
    expect(defaultGbaGameDir({ XDG_DATA_HOME: "/data" })).toBe(path.join("/data", "clankie", "gba"));
    // Unset falls back under the home directory rather than the process cwd.
    expect(defaultGbaGameDir({})).toContain(path.join(".local", "share", "clankie", "gba"));
  });

  it("boots the deterministic double when neither env nor the game home provide files", async () => {
    const emptyHome = mkdtempSync(path.join(tmpdir(), "gba-home-"));
    const game = await bootGbaGame(bootOptions({ XDG_DATA_HOME: emptyHome }));
    expect(game.real).toBe(false);
  });

  it("refuses Emerald when its operator-local ROM is absent", async () => {
    const emptyHome = mkdtempSync(path.join(tmpdir(), "gba-home-"));
    await expect(
      bootGbaGame({
        ...bootOptions({ XDG_DATA_HOME: emptyHome }),
        environmentId: "pokemon-emerald",
      }),
    ).rejects.toThrow(/Emerald ROM is not installed/u);
  });

  it("discovers an operator's game in the game home without any env", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "gba-home-"));
    const gameDir = path.join(home, "clankie", "gba");
    mkdirSync(gameDir, { recursive: true });
    // Present-but-invalid files prove discovery: the boot goes down the real
    // path and fails on content, rather than silently using the double.
    writeFileSync(path.join(gameDir, "firered.gba"), "not a rom");
    writeFileSync(path.join(gameDir, "firered-bedroom.state"), "not a savestate");
    await expect(bootGbaGame(bootOptions({ XDG_DATA_HOME: home }))).rejects.toThrow();
  });

  it("lets explicit env paths win over the game home and the double", async () => {
    // A configured path that does not exist must fail loudly, never fall back
    // to the double: the operator asked for a specific game.
    await expect(
      bootGbaGame(
        bootOptions({
          CLANKIE_GBA_ROM_PATH: "/nonexistent/rom.gba",
          CLANKIE_GBA_SAVESTATE_PATH: "/nonexistent/save.state",
        }),
      ),
    ).rejects.toThrow();
  });
});

describe.skipIf(!existsSync(EMERALD_ROM))("Emerald visual core (ROM-gated)", () => {
  it("boots the pinned title screen and accepts a real button press", async () => {
    const game = await bootGbaGame({
      ...bootOptions({ CLANKIE_GBA_ROM_PATH: EMERALD_ROM }),
      environmentId: "pokemon-emerald",
    });
    expect(game).toMatchObject({
      real: true,
      scenario: { scenarioId: "emerald-title-vision-v1" },
    });
    expect(game.framePng()).not.toBeNull();
    const titleFrame = game.framebufferSha256();
    expect(titleFrame).toMatch(/^[0-9a-f]{64}$/u);

    const core = game.coreFactory?.(game.scenario);
    expect(core?.gameState().mode).toBe("unknown");
    core?.pressButton("start", 1);
    expect(game.framebufferSha256()).not.toBe(titleFrame);
  });
});
