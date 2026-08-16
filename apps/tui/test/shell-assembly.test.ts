/**
 * Constructs the face shell without starting it (start() needs a TTY) and
 * asserts the basic wiring: setup flow idle, default layout, and the console
 * command set feeding the typeahead/workbench.
 */
import { describe, expect, it, vi } from "vitest";
import { buildConsoleCommands } from "../src/commands.ts";
import { ClankieFaceShell } from "../src/shell/shell.ts";

describe("shell assembly", () => {
  it("wires the face shell without starting it", () => {
    const commands = buildConsoleCommands({});
    const shell = new ClankieFaceShell({
      commands,
      cwd: process.cwd(),
      env: {},
      bannerFields: { title: "Clankie", tagline: "test" },
    });
    expect(shell.setupFlow.isWaitingForInput()).toBe(false);
    expect(shell.layoutSettings.inputPlacement).toBe("bottom");
  });

  it("builds a console command set with names and descriptions", () => {
    const commands = buildConsoleCommands({});
    expect(commands.length).toBeGreaterThanOrEqual(8);
    for (const command of commands) {
      expect(command.name.length).toBeGreaterThan(0);
      expect(command.description.length).toBeGreaterThan(0);
    }
  });

  it("lets an active setup prompt handle Escape", () => {
    const shell = new ClankieFaceShell({
      commands: buildConsoleCommands({}),
      cwd: process.cwd(),
      env: {},
      bannerFields: { title: "Clankie", tagline: "test" },
    });
    vi.spyOn(shell.setupFlow, "isWaitingForInput").mockReturnValue(true);
    vi.spyOn(shell.setupFlow, "hasActivePrompt").mockReturnValue(true);
    const cancel = vi.spyOn(shell.setupFlow, "handleSubmit");

    const routed = (
      shell as unknown as { routeInput(data: string): { consume?: boolean } | undefined }
    ).routeInput("\x1b");

    expect(routed).toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
  });
});
