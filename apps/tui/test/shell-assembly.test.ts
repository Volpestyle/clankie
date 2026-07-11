/**
 * Constructs the face shell without starting it (start() needs a TTY) and
 * asserts the basic wiring: setup flow idle, default layout, spinner resolved,
 * and the console command set feeding the typeahead/workbench.
 */
import { describe, expect, it } from "vitest";
import { buildConsoleCommands } from "../src/commands.ts";
import { createInitialConsoleState } from "../src/session/state.ts";
import { ClankieFaceShell } from "../src/shell/shell.ts";

describe("shell assembly", () => {
  it("wires the face shell without starting it", () => {
    const commands = buildConsoleCommands({ state: createInitialConsoleState() });
    const shell = new ClankieFaceShell({
      commands,
      cwd: process.cwd(),
      env: {},
      bannerFields: { title: "Clankie", tagline: "test" },
    });
    expect(shell.setupFlow.isWaitingForInput()).toBe(false);
    expect(shell.layoutSettings.inputPlacement).toBe("bottom");
    expect(shell.spinner.frames.length).toBeGreaterThan(0);
  });

  it("builds a console command set with names and descriptions", () => {
    const commands = buildConsoleCommands({ state: createInitialConsoleState() });
    expect(commands.length).toBeGreaterThanOrEqual(8);
    for (const command of commands) {
      expect(command.name.length).toBeGreaterThan(0);
      expect(command.description.length).toBeGreaterThan(0);
    }
  });
});
