import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { buildConsoleCommands } from "../src/commands.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";

function scriptedShell(choices: (string | undefined)[], texts: string[] = []) {
  const readSelect = vi.fn(
    async (_options: { message: string; options: { value: string; hint?: string }[] }) => choices.shift(),
  );
  const renderLine = vi.fn();
  const shell = {
    setupFlow: {
      begin: vi.fn(),
      end: vi.fn(),
      setStatus: vi.fn(),
      readSelect,
      readText: vi.fn(async () => texts.shift()),
      renderLine,
    },
    insertCommandResult: vi.fn(),
  } as unknown as ClankieFaceShell;
  return { shell, readSelect, renderLine };
}

/** Bare settings commands open a menu that writes the owner's real settings file. */
it("changes desktop quiet hours and browser recording from their bare menus", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settings-menus-"));
  try {
    const settings = new SettingsStore(join(directory, "settings.json"));
    const commands = buildConsoleCommands({ settings });
    const run = (name: string, shell: ClankieFaceShell) =>
      commands.find((command) => command.name === name)!.run("", shell);

    const desktop = scriptedShell(["set", undefined], ["23:00", "07:30", "Europe/London"]);
    await run("desktop", desktop.shell);
    expect((await settings.load()).desktop.quietHours).toEqual({
      start: "23:00",
      end: "07:30",
      timeZone: "Europe/London",
    });

    const before = (await settings.load()).browser.recordSessions;
    const browser = scriptedShell(["record", undefined]);
    await run("browser", browser.shell);
    expect((await settings.load()).browser.recordSessions).toBe(!before);
    expect(
      [...desktop.renderLine.mock.calls, ...browser.renderLine.mock.calls].some(
        ([, tone]) => tone === "error",
      ),
    ).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
