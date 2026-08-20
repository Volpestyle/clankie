import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGameSaveCommands } from "../src/game-save-commands.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";

describe("game save commands", () => {
  it("browses local saves and deletes one only after confirmation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "clankie-saves-"));
    const checkpointId = "2026-08-19T12-00-00-000Z-before-gym";
    const directory = join(rootDir, checkpointId);
    await mkdir(directory);
    await writeFile(
      join(directory, "checkpoint.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        checkpointId,
        label: "before-gym",
        capturedAt: "2026-08-19T12:00:00.000Z",
        romSha256: "a".repeat(64),
        coreWasmSha256: "b".repeat(64),
        savestateSha256: "c".repeat(64),
        position: { mapId: "PEWTER_CITY", x: 9, y: 14 },
        continuity: { notes: "Pikachu leads", objective: "challenge Brock" },
        journeyId: "local:pokemon-firered:profile:main",
        environmentId: "pokemon-firered",
      })}\n`,
    );

    const selections = [checkpointId, "delete", "delete"];
    const menus: Array<{ message: string; options: readonly { label: string }[]; initialValue?: string }> =
      [];
    const lines: string[] = [];
    const shell = {
      setupFlow: {
        begin() {},
        end() {},
        renderLine(text: string) {
          lines.push(text);
        },
        readSelect(options: (typeof menus)[number]) {
          menus.push(options);
          return Promise.resolve(selections.shift());
        },
      },
    } as unknown as ClankieFaceShell;
    const command = buildGameSaveCommands({ rootDir })[0];
    if (command === undefined) throw new Error("saves command missing");

    await command.run("", shell);

    expect(menus[0]?.options[0]?.label).toBe("FireRed · before-gym");
    expect(menus[1]?.message).toContain("PEWTER_CITY (9,14)");
    expect(menus[2]?.initialValue).toBe("cancel");
    expect(lines).toContain("Deleted FireRed · before-gym.");
    expect(existsSync(directory)).toBe(false);
  });
});
